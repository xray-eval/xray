"""LiveKit runtime — v1 implementation.

Joins the dev's LiveKit room as the user-side participant. Publishes
each user turn as a real audio track, records the agent continuously,
and tees both into a single stereo WAV mixdown (left = user, right =
agent) at ``~/.cache/xray-py/replays/<replay>.wav``.

**How recording works, in plain terms.** The old runtime only listened
to the agent while it was the agent's turn to talk. This one keeps
listening the whole time — from the moment the agent's audio track
appears until the run ends. So anything the agent says off-script (while
the user is talking, or a late reply after it seemed done) is captured
too, instead of being silently dropped. The user side is still driven
one turn at a time (we play exactly the scripted audio). Both sides are
laid onto a shared wall-clock timeline, so the two channels line up:
whoever spoke when is preserved, and silence fills the gaps.

Because a scripted run has to finish and return a result, "keep
listening forever" ends the moment the agent actually goes quiet: after
the last turn we wait until the agent has produced no speech for
``agent_quiet_period_s``, bounded by ``agent_turn_timeout_s`` so a
never-silent agent can't hang the run.

User-side audio is **server-fed**: the orchestrator prefetches every
user turn's 48 kHz mono WAV from
``GET /v1/conversations/:hash/turns/:idx/audio`` (the SDK-uploaded
recording for ``recorded`` turns, the server-synthesized speech for
``tts`` turns) and injects the PCM via :meth:`inject_user_audio` before
``run``. The runtime itself never touches a TTS provider or the local
filesystem for input audio — the bytes the agent hears are exactly the
bytes the conversation hash pinned.

Type safety: every LiveKit object reaches us through a Protocol from
``_livekit_types`` — no ``Any`` for foreign types. Branches over the
``Role`` Literal end in ``assert_never``.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import importlib
import logging
import math
import time
import wave
from collections.abc import AsyncGenerator, Callable, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from opentelemetry import baggage, context, trace
from typing_extensions import assert_never, override

from xray.conversation import (
    AgentResponse,
    Conversation,
    Role,
    Turn,
)
from xray.errors import (
    AgentNotJoinedError,
    AudioMissingError,
    LiveKitDependencyError,
    MixdownError,
    RuntimeBindError,
)
from xray.instrument import encode_attribute
from xray.runtime._livekit_types import (
    LkApiModule,
    LkAudioFrame,
    LkAudioSource,
    LkParticipant,
    LkRtcModule,
    LkTrack,
    LkTranscriptionSegment,
)
from xray.runtime.base import Runtime, RuntimeResult
from xray.runtime.sip import SimulatedSipCall

logger = logging.getLogger(__name__)

# LiveKit's default is 48 kHz mono. Matching the source rate avoids an
# in-process resampler dep (audioop is deprecated on 3.13+). The server
# stores all turn audio at this rate, so injected PCM needs no conversion.
SAMPLE_RATE: Final[int] = 48000
NUM_CHANNELS: Final[int] = 1
SAMPLE_WIDTH_BYTES: Final[int] = 2  # int16
FRAME_MS: Final[int] = 20
SAMPLES_PER_FRAME: Final[int] = SAMPLE_RATE * FRAME_MS // 1000

# A captured PCM frame tagged with the wall-clock second it arrived. Both
# runtimes feed this shape to write_stereo_mixdown; the scripted runtime
# converts its per-turn user segments into frames at mixdown time.
TimedFrame = tuple[float, bytes]


# Tracer used by the driver to emit per-user-turn ``xray.turn`` spans.
# The XrayBaggageSpanProcessor (installed by the orchestrator before
# ``runtime.run``) lifts the replay-scope baggage onto these spans so the OTLP
# receiver can route them to the replay. They land in the raw ``spans`` table
# for the inspector's turn timeline; the server derives ``replay_turns`` from
# VAD over the recording, not from these spans.
_TRACER = trace.get_tracer("xray-py-driver", "0.0.1")

# Provider control tags that leak into caption text. `<flush>` is
# Gradium's utterance-flush marker — it must never reach stored
# transcripts (spans, UI, judge input).
_CAPTION_CONTROL_TOKENS: Final[tuple[str, ...]] = ("<flush>",)


def _assemble_transcript(parts: Iterable[str]) -> str:
    """Join per-segment-id caption texts into one turn transcript.

    ``parts`` is the latest text per segment id, in first-arrival order.
    Cumulative caption streams re-send the whole utterance so far — and a
    final segment can arrive under a NEW id carrying the full utterance
    again — so texts are merged by containment: a part that extends the
    assembled text replaces it, a part the assembled text already starts
    with is dropped, anything else is appended with a space. Control
    tokens are stripped and whitespace collapsed before comparing, so
    token/spacing artifacts can't defeat the prefix check.
    """
    out = ""
    for raw in parts:
        text = raw
        for token in _CAPTION_CONTROL_TOKENS:
            text = text.replace(token, " ")
        text = " ".join(text.split())
        if not text:
            continue
        if not out or text.startswith(out):
            out = text
        elif out.startswith(text):
            continue
        else:
            out = f"{out} {text}"
    return out


@asynccontextmanager
async def _scoped_turn(idx: int, key: str | None = None) -> AsyncGenerator[None, None]:
    """Open a turn scope: a fresh trace root plus ``xray.turn.idx`` /
    ``xray.turn.key`` baggage. The root reset matters because this scope may be
    entered from inside another turn's span via ``asyncio.create_task`` (the
    barge-in user turn) — create_task copies the active context, so clearing the
    span slot keeps every turn span a root instead of nesting it under the
    agent's, while baggage still flows through."""
    ctx = trace.set_span_in_context(trace.INVALID_SPAN, context.get_current())
    ctx = baggage.set_baggage("xray.turn.idx", str(idx), context=ctx)
    if key is not None:
        ctx = baggage.set_baggage("xray.turn.key", key, context=ctx)
    token = context.attach(ctx)
    try:
        yield
    finally:
        context.detach(token)


@dataclass
class _TurnSegment:
    """One turn's driver-side record. User segments carry the published ``pcm``
    (their channel of the mixdown); agent segments carry only transcript and
    timing — the agent's audio comes from the continuous capture, not here."""

    role: Role
    idx: int
    key: str | None
    pcm: bytearray = field(default_factory=bytearray)
    started_at: float | None = None
    ended_at: float | None = None
    transcript: str = ""


def _pcm_duration_ms(pcm: bytes) -> int:
    """Duration of a mono int16 PCM buffer at ``SAMPLE_RATE``, in ms."""
    return (len(pcm) // SAMPLE_WIDTH_BYTES) * 1000 // SAMPLE_RATE


# int16 RMS separating agent speech from the silence/comfort-noise the
# AudioStream delivers while the agent is still "thinking" (~-36 dBFS): silence
# sits far below, TTS speech far above. The gap is decades wide, so the exact
# value isn't load-bearing.
_SPEECH_RMS_FLOOR: Final = 500.0

# Content-time silence that ends an agent UTTERANCE. Deliberately independent of
# `agent_quiet_period_s`, which ends a TURN: a turn holds however many utterances
# the agent produces before it yields the floor (narration, then the answer after
# a tool round-trip), so the utterance boundary has to be the shorter of the two.
# Intra-speech pauses sit well under it, so an utterance stays one unit; a
# barge-in that credits speech from before its tap stops crediting at this
# boundary — a stale credit spanning it would spend the head start inside the
# next utterance's silence prefix, the early fire cac718c fixed. Erring small
# only degrades to counting from the tap (today's behaviour).
_UTTERANCE_GAP_S: Final = 1.0


def _crosses_speech_floor(pcm: bytes) -> bool:
    """True once a mono int16 frame carries audio above the speech floor. Used
    as a one-shot onset latch so the barge-in counter starts at the agent's
    first word, not at capture start."""
    samples = array.array("h", pcm)
    if not samples:
        return False
    mean_square = sum(sample * sample for sample in samples) / len(samples)
    return math.sqrt(mean_square) >= _SPEECH_RMS_FLOOR


def _barge_in_user_turn(agent_turn: Turn, next_turn: Turn | None) -> Turn | None:
    """The user turn that barges into ``agent_turn``, or None. A barge-in pair
    is an agent turn immediately followed by a user turn carrying
    ``interrupt_after_ms`` (the placement Conversation already validated)."""
    if agent_turn.role != "agent" or next_turn is None:
        return None
    if next_turn.role == "user" and next_turn.interrupt_after_ms is not None:
        return next_turn
    return None


def _agent_response_for(segment: _TurnSegment) -> AgentResponse:
    duration_ms = (
        int((segment.ended_at - segment.started_at) * 1000)
        if segment.started_at is not None and segment.ended_at is not None
        else None
    )
    return AgentResponse(transcript=segment.transcript, duration_ms=duration_ms)


def _log_pump_failure(results: Sequence[None | BaseException]) -> None:
    """Surface a capture pump that died on its own rather than being cancelled.

    The teardown gather swallows exceptions so a failing pump can't mask the
    run's real outcome, but silence here is expensive: once the pump is dead no
    further frames arrive, so every remaining agent turn waits out
    ``agent_turn_timeout_s`` and returns an empty transcript with nothing in the
    logs to explain it. ``CancelledError`` is the expected teardown path and is
    not reported."""
    for result in results:
        if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
            logger.warning(
                "agent capture pump died before teardown (%s: %s) — agent audio after that "
                "point is missing from the recording and later turns will have timed out",
                type(result).__name__,
                result,
            )


async def _cancel_task(task: asyncio.Task[None]) -> None:
    """Cancel a still-running background task and swallow its cancellation."""
    if not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


class _AgentTranscript:
    """Accumulates the latest caption text per segment id for one agent turn
    and flags when a ``final`` segment arrives. Caption streams re-send a
    segment id with cumulatively growing text, so we keep only the latest text
    per id (never append) and assemble at the end. Shared by the normal
    agent-turn capture and the barge-in capture."""

    def __init__(self) -> None:
        self.latest_by_id: dict[str, str] = {}
        self.final_seen = asyncio.Event()

    def ingest(self, seg: LkTranscriptionSegment) -> None:
        self.latest_by_id[seg.id] = seg.text
        if seg.final:
            self.final_seen.set()

    def assemble(self) -> str:
        return _assemble_transcript(self.latest_by_id.values())


async def _drain_captions(
    transcript: _AgentTranscript,
    queue: asyncio.Queue[LkTranscriptionSegment],
) -> None:
    """Feed the queue into ``transcript`` until the caller cancels it.

    Runs past the first ``final`` segment on purpose: a caption stream marks
    *utterance* ends, and one turn can hold several — narration, then the answer
    after a tool round-trip. Stopping at the first final is what dropped the
    real answer from the turn's transcript (#117)."""
    while True:
        transcript.ingest(await queue.get())


def _drain_pending(
    transcript: _AgentTranscript,
    queue: asyncio.Queue[LkTranscriptionSegment],
) -> None:
    """Ingest whatever is already queued without blocking — segments can
    arrive before the drain task gets a turn on the loop (common when a fake
    stream finishes synchronously in tests)."""
    while not queue.empty():
        transcript.ingest(queue.get_nowait())


def _discard_pending(queue: asyncio.Queue[LkTranscriptionSegment]) -> None:
    """Drop any segments left from a prior turn before a new one starts — a
    stale ``final`` would otherwise satisfy this turn's drain instantly."""
    while not queue.empty():
        with contextlib.suppress(asyncio.QueueEmpty):
            queue.get_nowait()


@dataclass
class _BargeInTrigger:
    """Fires once, when ``after_ms`` of *voiced* agent audio has been received.

    Voiced time accrues only after the agent's speech onset — the captured
    stream leads with the agent's 'thinking' silence, which must not spend the
    budget — so the interruption counts from the agent's first word, exactly
    like the old per-turn counter (commits 3286b62 / cac718c)."""

    after_ms: int
    _voiced_ms: int = 0
    _speech_seen: bool = False
    _fired: bool = False

    def observe(self, pcm: bytes) -> bool:
        """Feed one received agent frame; returns True exactly once — on the
        frame that crosses the threshold."""
        if self._fired:
            return False
        if not self._speech_seen:
            self._speech_seen = _crosses_speech_floor(pcm)
        if self._speech_seen:
            self._voiced_ms += _pcm_duration_ms(pcm)
        if self._speech_seen and self._voiced_ms >= self.after_ms:
            self._fired = True
            return True
        return False

    def seed(self, voiced_ms: int) -> None:
        """Credit voiced agent speech the trigger never observed live — speech
        that began before its tap was installed (the pump captures the agent
        continuously; the tap starts only at the barge-in pair). Latches the
        onset too: crediting ``_voiced_ms`` alone would sit inert until a fresh
        post-tap onset, losing the head start when the agent is mid-utterance.
        A credit already past ``after_ms`` still fires on the next observed
        frame, not here — that frame carries the content cursor the interruption
        anchors to."""
        if voiced_ms <= 0:
            return
        self._speech_seen = True
        self._voiced_ms = voiced_ms


@dataclass
class _ContinuousAgentCapture:
    """Records the agent's audio for the whole run — one ``AudioStream``,
    opened when the agent's track first appears and drained until teardown.

    Because it never stops mid-run, audio the agent emits off-turn (while the
    user is speaking, or after its transcript goes final) is captured too —
    which the old per-turn capture structurally could not see. ``frames`` is the
    run-long timeline the mixdown reads.

    ``content_end_epoch`` is the placement cursor: the epoch coordinate where
    the next captured audio will sit in the mixdown, advanced by the same
    ``max(running, arrival)`` recurrence :func:`write_stereo_mixdown` uses. The
    barge-in trigger reads it to anchor the interrupting user turn to received
    agent *content* — immune to bursty ``AudioStream`` delivery — not
    wall-clock."""

    lk_rtc: LkRtcModule
    track_holder: list[LkTrack]
    track_event: asyncio.Event
    frames: list[TimedFrame] = field(default_factory=list[TimedFrame])
    content_end_epoch: float | None = None
    # Onset + last-voiced-end of the utterance in progress, in content-epoch
    # coordinates. A barge-in pair reaching capture mid-utterance reads these to
    # credit agent speech that preceded its tap (see current_utterance_ms).
    utterance_onset_epoch: float | None = None
    last_voiced_end_epoch: float | None = None
    # Set on every speech-level frame; the teardown quiet-wait clears it and
    # waits, so no wakeup is lost between clear and wait (Event is level-held).
    voiced: asyncio.Event = field(default_factory=asyncio.Event)
    _tap: Callable[[bytes, float], None] | None = None

    def set_tap(self, tap: Callable[[bytes, float], None] | None) -> None:
        """Install (or clear with None) a per-frame observer. The barge-in pair
        uses it to watch received agent content while it waits for the final."""
        self._tap = tap

    async def wait_for_track(self, *, timeout_s: float, room: str) -> None:
        """Block until the agent's audio track appears, raising
        ``AgentNotJoinedError`` if it never does within ``timeout_s`` — the gate
        an agent turn needs before it can expect audio; no-op once present. (The
        pump's own wait is unbounded and cancelled at teardown, so the
        turn-level fail-fast timeout lives here rather than in the pump.)"""
        if self.track_holder:
            return
        try:
            await asyncio.wait_for(self.track_event.wait(), timeout=timeout_s)
        except TimeoutError as e:
            raise AgentNotJoinedError(room, timeout_s) from e

    async def pump(self) -> None:
        """Wait for the agent track, then drain it into ``frames`` until
        cancelled at teardown. Returns quietly if the agent never publishes a
        track — a user-only run is valid. Mirrors the live runtime's
        ``_pump_agent`` minus the speaker."""
        if not self.track_holder:
            # Unbounded — teardown cancels this task. wait_for_track owns the
            # AgentNotJoinedError timeout for turns that actually need audio.
            await self.track_event.wait()
        track = self.track_holder[-1]
        stream = self.lk_rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)
        try:
            async for event in stream:
                self.on_frame(time.time(), bytes(event.frame.data))
        finally:
            await stream.aclose()

    def on_frame(self, arrival: float, pcm: bytes) -> None:
        """Record one agent frame: append it, advance the placement cursor, and
        notify the tap + the voiced-audio event. ``arrival`` is the wall-clock
        the frame was received (real runs) or a caller-supplied stamp (tests).
        The cursor uses ``max(running, arrival)`` so a decode burst lays
        back-to-back while a real gap inserts silence — identical to
        ``_place_frames``, kept incremental so the barge-in trigger can read the
        current content end."""
        self.frames.append((arrival, pcm))
        start = arrival if self.content_end_epoch is None else max(self.content_end_epoch, arrival)
        self.content_end_epoch = start + _pcm_duration_ms(pcm) / 1000
        if _crosses_speech_floor(pcm):
            # A >= _UTTERANCE_GAP_S content gap since the last voiced frame
            # (comfort noise or a frameless arrival gap, both surfaced by
            # ``start``) begins a new utterance; otherwise this frame extends it.
            if (
                self.last_voiced_end_epoch is None
                or start - self.last_voiced_end_epoch >= _UTTERANCE_GAP_S
            ):
                self.utterance_onset_epoch = start
            self.last_voiced_end_epoch = self.content_end_epoch
            self.voiced.set()
        if self._tap is not None:
            self._tap(pcm, self.content_end_epoch)

    def current_utterance_ms(self, *, now: float) -> int:
        """Voiced-plus-intra-pause ms of the utterance in progress, mirroring
        :meth:`_BargeInTrigger.observe`'s post-onset accounting so a seeded
        barge-in lands at the same content offset it would have live. Returns 0
        when the agent hasn't spoken, when the last speech was >= _UTTERANCE_GAP_S
        ago in content time (the utterance ended in trailing silence), or when
        ``now`` is >= _UTTERANCE_GAP_S past the last received frame (a DTX track
        gone frameless — without this a stale credit fires the trigger on the
        next utterance's first frame)."""
        if (
            self.utterance_onset_epoch is None
            or self.content_end_epoch is None
            or self.last_voiced_end_epoch is None
        ):
            return 0
        if self.content_end_epoch - self.last_voiced_end_epoch >= _UTTERANCE_GAP_S:
            return 0
        if self.frames and now - self.frames[-1][0] >= _UTTERANCE_GAP_S:
            return 0
        return int((self.content_end_epoch - self.utterance_onset_epoch) * 1000)


@dataclass
class LiveKitRuntime(Runtime):
    """Joins a LiveKit room as the user-side test driver. Plays the
    orchestrator-injected per-turn user audio, records the agent's audio
    continuously (see the module docstring), captures its transcripts,
    and writes one stereo WAV mixdown per replay.

    Despite living under ``xray.runtime``, this is the *user* side, not
    the agent side — the LiveKit Agents agent worker is the *other*
    side of the same room."""

    url: str
    api_key: str = field(repr=False)
    api_secret: str = field(repr=False)
    room: str
    identity: str = "xray-driver"
    agent_join_timeout_s: float = 30.0
    agent_turn_timeout_s: float = 30.0
    # How long the agent must stay silent before xray treats it as done —
    # applied to each agent turn's boundary and again after the last turn, so a
    # late off-turn reply still lands in the recording. Capped by
    # agent_turn_timeout_s so a never-silent agent can't hang the run. 0 ends a
    # turn as soon as the agent has spoken, and tears down immediately.
    #
    # 1.5s because measured intra-response pauses (an agent drawing breath
    # mid-answer) reach ~0.9s: a shorter window ends the turn mid-sentence and
    # the next user turn talks over the rest. A turn whose agent calls a slow
    # tool needs longer still — see Turn.agent(quiet_period_ms=...).
    agent_quiet_period_s: float = 1.5
    cache_root: Path = field(default_factory=lambda: Path.home() / ".cache" / "xray-py")
    mixdown_dir: Path | None = None
    # When set, the driver joins as ``ParticipantKind.SIP`` and carries the
    # configured ``sip.*`` attributes — letting a scripted replay exercise
    # the agent's production SIP code path without a bypass branch.
    simulated_sip: SimulatedSipCall | None = None

    # Injection points for tests. None ⇒ load the real packages.
    _lk_rtc: LkRtcModule | None = None
    _lk_api: LkApiModule | None = None

    # Populated by the orchestrator before ``run`` is called.
    replay_id: str | None = None
    conversation_hash: str | None = None
    # Per-turn 48 kHz mono int16 PCM, keyed by turn idx. The orchestrator
    # prefetches every user turn's audio from the server and injects it
    # here via ``inject_user_audio`` before ``run``.
    user_audio: dict[int, bytes] = field(default_factory=dict[int, bytes])

    def bind(
        self,
        *,
        replay_id: str,
        conversation_hash: str,
    ) -> None:
        """Called by the orchestrator once it knows the Replay's id."""
        self.replay_id = replay_id
        self.conversation_hash = conversation_hash

    def inject_user_audio(self, audio: Mapping[int, bytes]) -> None:
        """Receive the orchestrator-prefetched per-turn PCM (48 kHz mono
        int16), keyed by turn idx. Called before ``run``."""
        self.user_audio = dict(audio)

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        if self.replay_id is None or self.conversation_hash is None:
            raise RuntimeBindError(
                "LiveKitRuntime: bind(replay_id=..., conversation_hash=...) "
                "must be called before run()."
            )

        lk_rtc, lk_api = self._load_livekit()
        token = self._mint_token(lk_api)

        room = lk_rtc.Room()
        agent_joined = asyncio.Event()
        agent_track_event = asyncio.Event()
        agent_audio_track_holder: list[LkTrack] = []
        transcription_queue: asyncio.Queue[LkTranscriptionSegment] = asyncio.Queue()

        # `@room.on("event")` is a decorator that re-binds the function
        # name to its own return value — pyright then flags the inner
        # function as unused. Calling `room.on("event")(...)` directly
        # keeps the function as a read reference and discards the
        # decorator's return value.
        def _on_join(participant: LkParticipant) -> None:
            if participant.identity != self.identity:
                agent_joined.set()

        def _on_track(track: LkTrack, _publication: object, participant: LkParticipant) -> None:
            if participant.identity == self.identity:
                return
            # LiveKit's TrackKind is a protobuf enum — compare by integer
            # value or fall back to a string match. Mocks can supply either.
            kind = getattr(track, "kind", None)
            kind_audio = lk_rtc.TrackKind.KIND_AUDIO
            if kind == kind_audio or str(kind).lower().endswith("audio"):
                agent_audio_track_holder.append(track)
                agent_track_event.set()

        def _on_transcription(
            segments: list[LkTranscriptionSegment],
            participant: LkParticipant,
            _pub: object,
        ) -> None:
            if participant.identity == self.identity:
                return
            for seg in segments:
                transcription_queue.put_nowait(seg)

        room.on("participant_connected")(_on_join)
        room.on("track_subscribed")(_on_track)
        room.on("transcription_received")(_on_transcription)

        await room.connect(self.url, token, options=lk_rtc.RoomOptions())
        # The agent job is dispatched on room creation, so the agent can be
        # in the room before the driver connects — `participant_connected`
        # never fires for a participant that is already present, and the
        # join wait below would time out with both parties in the room.
        # Pre-existing *audio tracks* need no equivalent scan: with
        # autosubscribe, `track_subscribed` fires after connect for
        # existing publications.
        for existing in room.remote_participants.values():
            _on_join(existing)

        capture = _ContinuousAgentCapture(
            lk_rtc=lk_rtc,
            track_holder=agent_audio_track_holder,
            track_event=agent_track_event,
        )
        # Record the agent the instant its track appears — before the join wait
        # and before we publish our own track — so a greeting the agent emits on
        # join isn't clipped (AudioStream only delivers frames from the moment of
        # subscription). Same reason the live runtime starts its agent pump first.
        pump_task = asyncio.create_task(capture.pump())
        try:
            try:
                await asyncio.wait_for(agent_joined.wait(), timeout=self.agent_join_timeout_s)
            except TimeoutError as e:
                raise AgentNotJoinedError(self.room, self.agent_join_timeout_s) from e

            audio_source = lk_rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
            local_track = lk_rtc.LocalAudioTrack.create_audio_track("xray-user", audio_source)
            publish_opts = lk_rtc.TrackPublishOptions()
            publish_opts.source = lk_rtc.TrackSource.SOURCE_MICROPHONE
            await room.local_participant.publish_track(local_track, publish_opts)

            segments, responses = await self._play_turns(
                conversation=conversation,
                audio_source=audio_source,
                lk_rtc=lk_rtc,
                capture=capture,
                transcription_queue=transcription_queue,
            )
            # Don't stop at the last turn — hold on until the agent has actually
            # gone quiet, so a late "double answer" is still recorded.
            await self._await_agent_quiet(capture)
        finally:
            pump_task.cancel()
            _log_pump_failure(await asyncio.gather(pump_task, return_exceptions=True))
            await room.disconnect()

        mixdown_path, recording_t0 = self._write_mixdown(segments, capture.frames)
        return RuntimeResult(
            responses=responses,
            full_audio_path=str(mixdown_path) if mixdown_path is not None else None,
            recording_started_at_epoch=recording_t0,
            full_transcript=" ".join(r.transcript for r in responses if r.transcript).strip()
            or None,
        )

    async def _play_turns(
        self,
        *,
        conversation: Conversation,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
        capture: _ContinuousAgentCapture,
        transcription_queue: asyncio.Queue[LkTranscriptionSegment],
    ) -> tuple[list[_TurnSegment], list[AgentResponse]]:
        segments: list[_TurnSegment] = []
        responses: list[AgentResponse] = []
        turns = conversation.turns
        idx = 0
        while idx < len(turns):
            turn = turns[idx]
            next_turn = turns[idx + 1] if idx + 1 < len(turns) else None
            barge_in_user = _barge_in_user_turn(turn, next_turn)
            if barge_in_user is not None:
                # The next turn is a user turn that cuts into this agent turn.
                # Play the two together: capture the agent while, part-way
                # through, publishing the user's interruption over it. If the
                # agent finishes before the barge-in point there's nothing to
                # interrupt (`user_seg is None`) and the user turn falls through
                # to play normally on the next iteration.
                agent_seg, response, user_seg = await self._play_interrupted_pair(
                    agent_idx=idx,
                    agent_turn=turn,
                    user_idx=idx + 1,
                    user_turn=barge_in_user,
                    audio_source=audio_source,
                    lk_rtc=lk_rtc,
                    capture=capture,
                    transcription_queue=transcription_queue,
                )
                segments.append(agent_seg)
                responses.append(response)
                if user_seg is not None:
                    segments.append(user_seg)
                    responses.append(AgentResponse(transcript=""))
                    idx += 2
                    continue
                idx += 1
                continue

            async with _scoped_turn(idx, key=turn.key):
                match turn.role:
                    case "user":
                        user_only_seg = await self._play_user_turn(
                            idx=idx,
                            turn=turn,
                            audio_source=audio_source,
                            lk_rtc=lk_rtc,
                        )
                        segments.append(user_only_seg)
                        responses.append(AgentResponse(transcript=""))
                    case "agent":
                        agent_seg, response = await self._capture_agent_turn(
                            idx=idx,
                            turn=turn,
                            capture=capture,
                            transcription_queue=transcription_queue,
                        )
                        segments.append(agent_seg)
                        responses.append(response)
                    case _:
                        assert_never(turn.role)
            idx += 1
        return segments, responses

    async def _play_user_turn(
        self,
        *,
        idx: int,
        turn: Turn,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
    ) -> _TurnSegment:
        pcm = self._injected_user_pcm(idx)
        transcript = turn.text or ""
        segment = _TurnSegment(role="user", idx=idx, key=turn.key, transcript=transcript)
        # Emit an ``xray.turn`` span bracketing the audio publish so the user
        # turn shows on the inspector timeline (the server derives turn spans on
        # the recording via VAD; this span is what makes the user side visible).
        with _TRACER.start_as_current_span("xray.turn") as span:
            span.set_attribute("xray.turn.idx", idx)
            span.set_attribute("xray.turn.role", "user")
            if transcript:
                span.set_attribute("xray.turn.transcript", transcript)
            if turn.key is not None:
                span.set_attribute("xray.turn.key", turn.key)
            segment.started_at = time.time()
            await self._publish_pcm(
                audio_source=audio_source, lk_rtc=lk_rtc, pcm=pcm, segment=segment
            )
            segment.ended_at = time.time()
        return segment

    async def _publish_pcm(
        self,
        *,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
        pcm: bytes,
        segment: _TurnSegment,
    ) -> None:
        """Trailing partial frame is zero-padded — LiveKit's AudioFrame
        rejects a buffer shorter than ``samples_per_channel * 2``."""
        bytes_per_frame = SAMPLES_PER_FRAME * SAMPLE_WIDTH_BYTES * NUM_CHANNELS
        for start in range(0, len(pcm), bytes_per_frame):
            chunk = pcm[start : start + bytes_per_frame]
            if len(chunk) < bytes_per_frame:
                chunk = chunk + b"\x00" * (bytes_per_frame - len(chunk))
            frame: LkAudioFrame = lk_rtc.AudioFrame(
                data=chunk,
                sample_rate=SAMPLE_RATE,
                num_channels=NUM_CHANNELS,
                samples_per_channel=SAMPLES_PER_FRAME,
            )
            await audio_source.capture_frame(frame)
            segment.pcm.extend(chunk)

    async def _capture_agent_turn(
        self,
        *,
        idx: int,
        turn: Turn,
        capture: _ContinuousAgentCapture,
        transcription_queue: asyncio.Queue[LkTranscriptionSegment],
    ) -> tuple[_TurnSegment, AgentResponse]:
        # The agent's audio is recorded continuously by the background pump; an
        # agent turn only paces on the transcript. Still gate on the track so a
        # scripted agent turn against a silent room fails fast, exactly as
        # before.
        await capture.wait_for_track(timeout_s=self.agent_turn_timeout_s, room=self.room)
        _discard_pending(transcription_queue)

        segment = _TurnSegment(role="agent", idx=idx, key=turn.key)
        transcript = _AgentTranscript()

        # Emit the agent-role ``xray.turn`` span from the driver. The driver
        # owns turn-idx allocation (enumerated from ``conversation.turns``), so
        # its spans never collide on the ``(replay_id, idx)`` key. These land in
        # the raw ``spans`` table for the inspector timeline; the server derives
        # ``replay_turns`` from VAD over the recording, not from them.
        with _TRACER.start_as_current_span("xray.turn") as span:
            span.set_attribute("xray.turn.idx", idx)
            span.set_attribute("xray.turn.role", "agent")
            if turn.key is not None:
                span.set_attribute("xray.turn.key", turn.key)
            segment.started_at = time.time()
            transcript_task = asyncio.create_task(_drain_captions(transcript, transcription_queue))
            try:
                await self._await_agent_turn_end(
                    capture, transcript, quiet_period_s=self._quiet_period_s_for(turn)
                )
            finally:
                await _cancel_task(transcript_task)
            _drain_pending(transcript, transcription_queue)

            segment.ended_at = time.time()
            segment.transcript = transcript.assemble()
            if segment.transcript:
                span.set_attribute("xray.turn.transcript", segment.transcript)

        return segment, _agent_response_for(segment)

    async def _play_interrupted_pair(
        self,
        *,
        agent_idx: int,
        agent_turn: Turn,
        user_idx: int,
        user_turn: Turn,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
        capture: _ContinuousAgentCapture,
        transcription_queue: asyncio.Queue[LkTranscriptionSegment],
    ) -> tuple[_TurnSegment, AgentResponse, _TurnSegment | None]:
        """Pace the agent turn and, once ``interrupt_after_ms`` of its *voiced*
        audio has been captured, start publishing the user's turn over it — so
        the recording carries both speakers at the barge-in point and the server
        can measure how fast the agent yields.

        The trigger counts *received agent content*, not wall-clock: it lands at
        the same point in the agent's response run-to-run, immune to network
        jitter and to the agent's response latency (issue #113 req 2).

        Returns the user segment only if the interruption actually fired. If the
        agent finished speaking first, there was nothing to interrupt —
        `user_seg` is None and the caller plays the user turn normally.
        """
        await capture.wait_for_track(timeout_s=self.agent_turn_timeout_s, room=self.room)
        _discard_pending(transcription_queue)

        # `interrupt_after_ms` is guaranteed set for a barge-in pair; the
        # fallback keeps the type honest without a bare assert.
        trigger = _BargeInTrigger(after_ms=user_turn.interrupt_after_ms or 0)
        user_pcm = self._injected_user_pcm(user_idx)

        agent_seg = _TurnSegment(role="agent", idx=agent_idx, key=agent_turn.key)
        transcript = _AgentTranscript()
        user_seg: _TurnSegment | None = None
        user_publish_task: asyncio.Task[None] | None = None

        # Scope the agent capture like every other turn — without this its
        # driver spans lose turn baggage, since the barge-in branch runs before
        # the caller's own _scoped_turn wrapper.
        async with _scoped_turn(agent_idx, key=agent_turn.key):
            with _TRACER.start_as_current_span("xray.turn") as agent_span:
                agent_span.set_attribute("xray.turn.idx", agent_idx)
                agent_span.set_attribute("xray.turn.role", "agent")
                if agent_turn.key is not None:
                    agent_span.set_attribute("xray.turn.key", agent_turn.key)

                def _tap(pcm: bytes, content_end_epoch: float) -> None:
                    nonlocal user_seg, user_publish_task
                    # Anchor the agent turn's start to its first captured frame
                    # so the barge-in gap is measured in the same (arrival)
                    # clock as the recording, not wall-clock.
                    if agent_seg.started_at is None:
                        agent_seg.started_at = content_end_epoch - _pcm_duration_ms(pcm) / 1000
                    # No `final_seen` guard: one turn can hold several
                    # utterances, so a final caption doesn't mean the agent is
                    # done and a barge-in may legitimately land on a later one.
                    # The turn-end wait clears the tap, which is what stops it.
                    if user_publish_task is not None:
                        return
                    if trigger.observe(pcm):
                        # started_at is the content cursor after the triggering
                        # frame (agent onset + received content), NOT wall-clock:
                        # AudioStream bursts ahead of realtime, so a wall-clock
                        # stamp would land the interruption early and inflate
                        # yield_ms (see write_stereo_mixdown's burst note).
                        user_seg, user_publish_task = self._begin_interruption(
                            user_idx=user_idx,
                            user_turn=user_turn,
                            user_pcm=user_pcm,
                            started_at=content_end_epoch,
                            audio_source=audio_source,
                            lk_rtc=lk_rtc,
                        )

                # The pump has recorded the agent since its track appeared, but
                # the tap sees frames only from here. Credit speech that began
                # before the pair so interrupt_after_ms counts from the agent's
                # first word, not its first word after the tap — a full-duplex
                # agent replies during the prior turn, and the docs promise a
                # barge-in point stable "regardless of the agent's latency".
                head_start_ms = capture.current_utterance_ms(now=time.time())
                onset = capture.utterance_onset_epoch
                if head_start_ms > 0 and onset is not None:
                    trigger.seed(head_start_ms)
                    # Backdate the agent start to the true onset — the tap's own
                    # is-None anchor then no-ops — so the recorded turn start and
                    # AgentResponse.duration_ms include the pre-tap speech.
                    agent_seg.started_at = onset

                capture.set_tap(_tap)
                try:
                    transcript_task = asyncio.create_task(
                        _drain_captions(transcript, transcription_queue)
                    )
                    # Keep the tap live until the agent goes quiet — its tail
                    # (how long it keeps talking past the barge-in) is what the
                    # yield metric measures.
                    try:
                        await self._await_agent_turn_end(
                            capture, transcript, quiet_period_s=self._quiet_period_s_for(agent_turn)
                        )
                    finally:
                        await _cancel_task(transcript_task)
                    _drain_pending(transcript, transcription_queue)
                finally:
                    # A stale tap must never observe the next pair's frames.
                    capture.set_tap(None)

                if agent_seg.started_at is None:
                    # No frame was ever observed (silent agent) — stamp the turn
                    # so the span and response still carry a start.
                    agent_seg.started_at = time.time()
                agent_seg.ended_at = time.time()
                agent_seg.transcript = transcript.assemble()
                if agent_seg.transcript:
                    agent_span.set_attribute("xray.turn.transcript", agent_seg.transcript)

        if user_publish_task is not None:
            await user_publish_task
        if user_seg is not None and user_seg.started_at is not None:
            # End the user segment at its own content duration, consistent with
            # the content-timed start — a wall-clock stamp here could precede
            # the content-derived start under bursty delivery.
            user_seg.ended_at = user_seg.started_at + _pcm_duration_ms(bytes(user_seg.pcm)) / 1000

        return agent_seg, _agent_response_for(agent_seg), user_seg

    def _begin_interruption(
        self,
        *,
        user_idx: int,
        user_turn: Turn,
        user_pcm: bytes,
        started_at: float,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
    ) -> tuple[_TurnSegment, asyncio.Task[None]]:
        """Kick off publishing the user's audio concurrently with the ongoing
        agent capture. ``started_at`` is the CONTENT-derived barge-in time
        (agent onset + received agent audio), not wall-clock — see the caller
        for why. The user span is emitted under the user turn's own baggage
        scope."""
        user_seg = _TurnSegment(
            role="user", idx=user_idx, key=user_turn.key, transcript=user_turn.text or ""
        )
        user_seg.started_at = started_at

        async def _publish() -> None:
            async with _scoped_turn(user_idx, key=user_turn.key):
                with _TRACER.start_as_current_span("xray.turn") as span:
                    span.set_attribute("xray.turn.idx", user_idx)
                    span.set_attribute("xray.turn.role", "user")
                    if user_seg.transcript:
                        span.set_attribute("xray.turn.transcript", user_seg.transcript)
                    if user_turn.key is not None:
                        span.set_attribute("xray.turn.key", user_turn.key)
                    await self._publish_pcm(
                        audio_source=audio_source, lk_rtc=lk_rtc, pcm=user_pcm, segment=user_seg
                    )

        return user_seg, asyncio.create_task(_publish())

    def _quiet_period_s_for(self, turn: Turn) -> float:
        """The turn's declared quiet period, else the runtime default."""
        if turn.quiet_period_ms is None:
            return self.agent_quiet_period_s
        return turn.quiet_period_ms / 1000

    async def _await_agent_turn_end(
        self,
        capture: _ContinuousAgentCapture,
        transcript: _AgentTranscript,
        *,
        quiet_period_s: float,
    ) -> None:
        """Hold an agent turn until the agent yields the floor: it has started
        (speech-level audio, or a caption going final), then produced no
        speech-level audio for ``quiet_period_s``.

        Silence ends the turn, not the first ``final`` caption. Captions mark
        *utterance* ends: an agent that narrates before a tool call goes final on
        the holding sentence while its real answer is still minutes of tool
        latency away, so ending there both truncates the turn's transcript and
        makes the driver talk over the answer (#117). Capped by
        ``agent_turn_timeout_s`` so an agent that never stops can't hang the run.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.agent_turn_timeout_s
        if not await self._await_agent_onset(capture, transcript, deadline=deadline):
            return
        if quiet_period_s <= 0:
            return
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                logger.warning(
                    "agent turn hit agent_turn_timeout_s=%.1fs without going quiet for %.2fs — "
                    "the turn boundary is a timeout, not the agent yielding",
                    self.agent_turn_timeout_s,
                    quiet_period_s,
                )
                return
            capture.voiced.clear()
            try:
                await asyncio.wait_for(
                    capture.voiced.wait(), timeout=min(quiet_period_s, remaining)
                )
            except TimeoutError:
                # A full quiet window with no new agent speech → the agent is done.
                return

    async def _await_agent_onset(
        self,
        capture: _ContinuousAgentCapture,
        transcript: _AgentTranscript,
        *,
        deadline: float,
    ) -> bool:
        """Wait for this turn's first sign of the agent — a speech-level frame or
        a final caption. False when neither arrived before ``deadline``: a silent
        agent, whose turn is empty but still valid.

        ``capture.voiced`` is cleared first so the wait needs a *fresh* frame.
        The event is level-held and run-long, so a previous turn's speech would
        otherwise satisfy the onset instantly — and the quiet loop would then end
        this turn while the agent was merely slow to start (measured: up to 3.1s
        of pre-speech silence before a tool-backed answer).
        """
        if transcript.final_seen.is_set():
            return True
        capture.voiced.clear()
        loop = asyncio.get_running_loop()
        waiters = [
            asyncio.ensure_future(capture.voiced.wait()),
            asyncio.ensure_future(transcript.final_seen.wait()),
        ]
        try:
            done, _pending = await asyncio.wait(
                waiters,
                timeout=max(0.0, deadline - loop.time()),
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for waiter in waiters:
                if not waiter.done():
                    waiter.cancel()
        return len(done) > 0

    async def _await_agent_quiet(self, capture: _ContinuousAgentCapture) -> None:
        """Hold after the last scripted turn until the agent has been quiet for
        ``agent_quiet_period_s`` — so a late off-turn reply still lands in the
        recording instead of being cut off by teardown. Unlike a turn boundary
        there is no onset to wait for: the conversation is over, we're only
        draining a tail that may never come."""
        if self.agent_quiet_period_s <= 0:
            return
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.agent_turn_timeout_s
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            capture.voiced.clear()
            try:
                await asyncio.wait_for(
                    capture.voiced.wait(), timeout=min(self.agent_quiet_period_s, remaining)
                )
            except TimeoutError:
                return

    def _write_mixdown(
        self, segments: list[_TurnSegment], agent_frames: list[TimedFrame]
    ) -> tuple[Path | None, float | None]:
        if not segments and not agent_frames:
            return None, None
        mixdown_root = self.mixdown_dir or (self.cache_root / "replays")
        mixdown_root.mkdir(parents=True, exist_ok=True)
        out_path = mixdown_root / f"{self.replay_id}.wav"
        # User audio is driver-authored per turn; the agent channel is the
        # continuous capture. Only user segments carry PCM now — agent segments
        # exist for their transcript and timing.
        user_frames: list[TimedFrame] = []
        for s in segments:
            if s.role != "user" or not s.pcm or s.started_at is None:
                continue
            user_frames.append((s.started_at, bytes(s.pcm)))
        try:
            recording_t0 = write_stereo_mixdown(
                user_frames=user_frames, agent_frames=agent_frames, out_path=out_path
            )
        except OSError as e:
            raise MixdownError(f"could not write mixdown WAV: {e}") from e
        return out_path, recording_t0

    def _injected_user_pcm(self, idx: int) -> bytes:
        """PCM for user turn ``idx`` from the orchestrator-injected map.
        Absence is a programming error in the calling layer (prefetch
        skipped, or the runtime was run without an orchestrator) — not a
        recoverable condition, so it raises ``AudioMissingError`` with the
        turn pinned."""
        pcm = self.user_audio.get(idx)
        if pcm is None:
            raise AudioMissingError(
                f"turn {idx}: no injected user audio — run the runtime via xray.run() "
                "(the orchestrator prefetches turn audio from the server), or inject "
                "PCM via inject_user_audio().",
                turn_idx=idx,
            )
        return pcm

    def _mint_token(self, lk_api: LkApiModule) -> str:
        """JWT for the user-side driver. The replay context rides on the
        token as a single ``xray`` attribute (JSON blob) — the agent's
        :func:`xray.instrument` decorator parses it from
        ``participant.attributes`` on join. No participant-metadata
        set, no ``can_update_own_metadata`` grant needed."""
        if self.replay_id is None or self.conversation_hash is None:
            raise RuntimeBindError(
                "LiveKitRuntime: bind(replay_id=..., conversation_hash=...) "
                "must be called before token minting."
            )
        return mint_user_token(
            lk_api,
            api_key=self.api_key,
            api_secret=self.api_secret,
            room=self.room,
            identity=self.identity,
            replay_id=self.replay_id,
            conversation_hash=self.conversation_hash,
            simulated_sip=self.simulated_sip,
        )

    def _load_livekit(self) -> tuple[LkRtcModule, LkApiModule]:
        return load_livekit_modules(self._lk_rtc, self._lk_api)

    @override
    async def aclose(self) -> None:
        return None


def load_livekit_modules(
    injected_rtc: LkRtcModule | None,
    injected_api: LkApiModule | None,
) -> tuple[LkRtcModule, LkApiModule]:
    """Resolve the ``livekit.rtc`` / ``livekit.api`` modules, preferring
    test-injected fakes. Loaded via importlib so pyright doesn't resolve
    `livekit` at type-check time — the Protocols in `_livekit_types` are the
    static contract; `isinstance` against them is the runtime gate. CI
    therefore doesn't need `pip install ...[livekit]`."""
    if injected_rtc is not None and injected_api is not None:
        return injected_rtc, injected_api
    try:
        lk_rtc_mod: object = importlib.import_module("livekit.rtc")
        lk_api_mod: object = importlib.import_module("livekit.api")
    except ImportError as e:
        raise LiveKitDependencyError("This runtime requires `pip install xray-py[livekit]`.") from e
    if not isinstance(lk_rtc_mod, LkRtcModule):
        raise LiveKitDependencyError(
            "livekit.rtc is missing one of the required attributes "
            "(AudioSource / AudioFrame / Room / …). Installed livekit "
            "version may be incompatible."
        )
    if not isinstance(lk_api_mod, LkApiModule):
        raise LiveKitDependencyError(
            "livekit.api is missing AccessToken / VideoGrants. "
            "Installed livekit-api version may be incompatible."
        )
    return lk_rtc_mod, lk_api_mod


def mint_user_token(
    lk_api: LkApiModule,
    *,
    api_key: str,
    api_secret: str,
    room: str,
    identity: str,
    replay_id: str,
    conversation_hash: str,
    simulated_sip: SimulatedSipCall | None = None,
) -> str:
    """Mint the user-side driver JWT carrying the ``xray`` token-claim
    attribute (the agent reads it via ``participant.attributes`` to bind the
    replay context). Shared by the scripted and live runtimes.

    When ``simulated_sip`` is provided the token additionally declares
    ``kind=sip`` plus the ``sip.*`` attributes — see
    :class:`xray.runtime.sip.SimulatedSipCall`.
    """
    attributes = encode_attribute(replay_id=replay_id, conversation_hash=conversation_hash)
    if simulated_sip is not None:
        # sip.* keys never overlap "xray", and SimulatedSipCall rejects an
        # "xray" key in extra_attrs at construction — so this merge provably
        # cannot clobber the replay-binding attribute.
        attributes = {**attributes, **simulated_sip.to_attributes()}
    builder = lk_api.AccessToken(api_key, api_secret)
    builder = builder.with_identity(identity)
    builder = builder.with_grants(lk_api.VideoGrants(room_join=True, room=room))
    if simulated_sip is not None:
        builder = builder.with_kind("sip")
    builder = builder.with_attributes(attributes)
    return builder.to_jwt()


def write_stereo_mixdown(
    *,
    user_frames: list[TimedFrame],
    agent_frames: list[TimedFrame],
    out_path: Path,
) -> float | None:
    """Write a wall-clock-aligned stereo WAV: left = user, right = agent.
    Each frame is ``(arrival_epoch_seconds, int16_pcm_bytes)``. Both runtimes
    feed this same shape — the live runtime from its mic/agent pumps, the
    scripted runtime from its per-turn user segments plus the continuous
    agent capture.

    Within a channel, frames are laid **sequentially** — each at
    ``max(running_position, arrival_offset)`` — not at their raw arrival
    offset. LiveKit's ``AudioStream`` decodes *consecutive* frames in bursts
    ahead of real time, so many frames share near-identical arrival stamps;
    placing each at its raw offset collapses the burst onto overlapping
    samples and garbles the channel. ``max(running, arrival)`` lays a burst
    back-to-back while a genuine arrival gap still inserts silence, so
    cross-channel timing — who spoke when — is preserved. The server derives
    turn boundaries by running VAD over this file.

    Returns ``t0`` — the Unix-epoch wall-clock of audio sample 0 — as the
    recording anchor the orchestrator sends on upload. None when no audio was
    placed (empty WAV)."""
    user = [(t, pcm) for t, pcm in user_frames if pcm]
    agent = [(t, pcm) for t, pcm in agent_frames if pcm]
    if not user and not agent:
        # Empty WAV: header + zero data. Keeps callers from special-casing.
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(SAMPLE_WIDTH_BYTES)
            w.setframerate(SAMPLE_RATE)
        return None

    t0 = min(t for t, _pcm in [*user, *agent])
    user_placed, user_total = _place_frames(user, t0)
    agent_placed, agent_total = _place_frames(agent, t0)
    total_samples = max(user_total, agent_total)

    left = bytearray(total_samples * SAMPLE_WIDTH_BYTES)
    right = bytearray(total_samples * SAMPLE_WIDTH_BYTES)
    for offset_bytes, pcm in user_placed:
        _mix_into(left, offset_bytes, bytearray(pcm))
    for offset_bytes, pcm in agent_placed:
        _mix_into(right, offset_bytes, bytearray(pcm))

    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(SAMPLE_WIDTH_BYTES)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(_interleave_lr(left=bytes(left), right=bytes(right)))

    return t0


def _place_frames(frames: list[TimedFrame], t0: float) -> tuple[list[tuple[int, bytes]], int]:
    """Compute byte offsets for one channel's frames, laying bursts
    sequentially while honoring genuine arrival gaps. Returns the
    ``(offset_bytes, pcm)`` placements and the channel's total sample count."""
    placed: list[tuple[int, bytes]] = []
    running_samples = 0
    for t, pcm in frames:
        arrival_samples = max(0, int((t - t0) * SAMPLE_RATE))
        pos_samples = max(running_samples, arrival_samples)
        placed.append((pos_samples * SAMPLE_WIDTH_BYTES, pcm))
        running_samples = pos_samples + len(pcm) // SAMPLE_WIDTH_BYTES
    return placed, running_samples


def _mix_into(dest: bytearray, offset_bytes: int, src: bytearray) -> None:
    """Copy `src` into `dest` at `offset_bytes`. Truncates if `src` would
    overrun `dest` (caller has already sized `dest` to accommodate the
    farthest-reaching segment)."""
    end = offset_bytes + len(src)
    if end > len(dest):
        end = len(dest)
    dest[offset_bytes:end] = src[: end - offset_bytes]


def _interleave_lr(*, left: bytes, right: bytes) -> bytes:
    """Interleave two equal-length mono int16 streams into stereo int16."""
    if len(left) != len(right):
        raise MixdownError(
            f"channel length mismatch during mixdown: left={len(left)}, right={len(right)}"
        )
    l_samples = array.array("h")
    l_samples.frombytes(left)
    r_samples = array.array("h")
    r_samples.frombytes(right)
    out = array.array("h", bytes(len(l_samples) * 4))
    out[0::2] = l_samples
    out[1::2] = r_samples
    return out.tobytes()
