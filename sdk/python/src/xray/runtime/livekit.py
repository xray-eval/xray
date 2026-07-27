"""LiveKit runtime — v1 implementation.

Joins the dev's LiveKit room as the user-side participant. Publishes
each user turn as a real audio track, captures the agent's audio +
transcripts, and tees both into a single stereo WAV mixdown (left =
user, right = agent) at ``~/.cache/xray-py/replays/<replay>.wav``.

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
import time
import wave
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterable, Mapping
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
    LkAudioStream,
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


# Tracer used by the driver to emit per-user-turn ``xray.turn`` spans.
# The XrayBaggageSpanProcessor (installed by the orchestrator before
# ``runtime.run``) lifts the replay-scope baggage onto these spans so
# the OTLP receiver can route them to ``replay_turns``.
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
    """Scope ``xray.turn.idx`` / ``xray.turn.key`` baggage to a block.
    Used internally by the driver so user turns also carry per-turn
    attribution on the user-side spans (mostly span-tree breadcrumbs)."""
    ctx = context.get_current()
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
    """PCM captured for one turn, used to assemble the mixdown."""

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


async def _drain_until_final(
    transcript: _AgentTranscript,
    queue: asyncio.Queue[LkTranscriptionSegment],
) -> None:
    """Feed the queue into ``transcript`` until a final segment lands."""
    while not transcript.final_seen.is_set():
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
class LiveKitRuntime(Runtime):
    """Joins a LiveKit room as the user-side test driver. Plays the
    orchestrator-injected per-turn audio, captures the agent's
    transcripts + audio, and writes one stereo WAV mixdown per replay.

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
                agent_audio_track_holder=agent_audio_track_holder,
                agent_track_event=agent_track_event,
                transcription_queue=transcription_queue,
            )
        finally:
            await room.disconnect()

        mixdown_path, recording_t0 = self._write_mixdown(segments)
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
        agent_audio_track_holder: list[LkTrack],
        agent_track_event: asyncio.Event,
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
                    agent_audio_track_holder=agent_audio_track_holder,
                    agent_track_event=agent_track_event,
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
                            lk_rtc=lk_rtc,
                            agent_audio_track_holder=agent_audio_track_holder,
                            agent_track_event=agent_track_event,
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
        # Emit an ``xray.turn`` span scoped to the audio publish so the
        # server vocabulary records this user turn in ``replay_turns``
        # with real start/end timestamps — the only place those exist
        # is here, where we actually push the bytes onto the wire.
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

    async def _await_agent_track(
        self,
        *,
        agent_audio_track_holder: list[LkTrack],
        agent_track_event: asyncio.Event,
    ) -> LkTrack:
        # `agent_track_event` is one-time (track subscription is room-scoped,
        # not turn-scoped). Only wait on it if we don't yet have a track —
        # otherwise the wait would return immediately on turn 2+ and the
        # configured `agent_turn_timeout_s` would silently no-op.
        if not agent_audio_track_holder:
            try:
                await asyncio.wait_for(agent_track_event.wait(), timeout=self.agent_turn_timeout_s)
            except TimeoutError as e:
                raise AgentNotJoinedError(self.room, self.agent_turn_timeout_s) from e
        return agent_audio_track_holder[-1]

    async def _capture_agent_turn(
        self,
        *,
        idx: int,
        turn: Turn,
        lk_rtc: LkRtcModule,
        agent_audio_track_holder: list[LkTrack],
        agent_track_event: asyncio.Event,
        transcription_queue: asyncio.Queue[LkTranscriptionSegment],
    ) -> tuple[_TurnSegment, AgentResponse]:
        track = await self._await_agent_track(
            agent_audio_track_holder=agent_audio_track_holder,
            agent_track_event=agent_track_event,
        )
        stream = lk_rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)
        _discard_pending(transcription_queue)

        segment = _TurnSegment(role="agent", idx=idx, key=turn.key)
        transcript = _AgentTranscript()

        # Emit the agent-role ``xray.turn`` span from the driver too.
        # The driver owns turn-idx allocation end-to-end (enumerated
        # from ``conversation.turns``), so it is the only side that can
        # emit replay_turns rows without colliding on the
        # ``(replay_id, idx)`` primary key — an agent worker emitting
        # its own ``xray.turn`` for the same idx would have its row
        # last-write-win over the driver's.
        with _TRACER.start_as_current_span("xray.turn") as span:
            span.set_attribute("xray.turn.idx", idx)
            span.set_attribute("xray.turn.role", "agent")
            if turn.key is not None:
                span.set_attribute("xray.turn.key", turn.key)
            segment.started_at = time.time()
            transcript_task = asyncio.create_task(
                _drain_until_final(transcript, transcription_queue)
            )

            async def _consume_frames() -> None:
                async for event in stream:
                    segment.pcm.extend(bytes(event.frame.data))
                    if transcript.final_seen.is_set():
                        break

            await self._run_agent_consume(_consume_frames, stream, transcript, transcription_queue)
            await _cancel_task(transcript_task)

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
        agent_audio_track_holder: list[LkTrack],
        agent_track_event: asyncio.Event,
        transcription_queue: asyncio.Queue[LkTranscriptionSegment],
    ) -> tuple[_TurnSegment, AgentResponse, _TurnSegment | None]:
        """Capture the agent turn and, once ``interrupt_after_ms`` of its audio
        has been received, start publishing the user's turn over it — so the
        recording carries both speakers at the barge-in point and the server
        can measure how fast the agent yields.

        The trigger is a count of *received agent audio*, not wall-clock: it
        lands at the same point in the agent's response run-to-run, immune to
        network jitter and to the agent's response latency (issue #113 req 2).

        Returns the user segment only if the interruption actually fired. If
        the agent finished speaking first, there was nothing to interrupt —
        `user_seg` is None and the caller plays the user turn normally.
        """
        # `interrupt_after_ms` is guaranteed set for a barge-in pair; the
        # fallback keeps the type honest without a bare assert.
        after_ms = user_turn.interrupt_after_ms or 0
        user_pcm = self._injected_user_pcm(user_idx)

        track = await self._await_agent_track(
            agent_audio_track_holder=agent_audio_track_holder,
            agent_track_event=agent_track_event,
        )
        stream = lk_rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)
        _discard_pending(transcription_queue)

        agent_seg = _TurnSegment(role="agent", idx=agent_idx, key=agent_turn.key)
        transcript = _AgentTranscript()
        user_seg: _TurnSegment | None = None
        user_publish_task: asyncio.Task[None] | None = None

        with _TRACER.start_as_current_span("xray.turn") as agent_span:
            agent_span.set_attribute("xray.turn.idx", agent_idx)
            agent_span.set_attribute("xray.turn.role", "agent")
            if agent_turn.key is not None:
                agent_span.set_attribute("xray.turn.key", agent_turn.key)
            agent_seg.started_at = time.time()
            transcript_task = asyncio.create_task(
                _drain_until_final(transcript, transcription_queue)
            )
            received_ms = 0

            async def _consume_frames() -> None:
                nonlocal user_seg, user_publish_task, received_ms
                async for event in stream:
                    data = bytes(event.frame.data)
                    agent_seg.pcm.extend(data)
                    if user_publish_task is None and not transcript.final_seen.is_set():
                        received_ms += _pcm_duration_ms(data)
                        if received_ms >= after_ms:
                            user_seg, user_publish_task = self._begin_interruption(
                                user_idx=user_idx,
                                user_turn=user_turn,
                                user_pcm=user_pcm,
                                audio_source=audio_source,
                                lk_rtc=lk_rtc,
                            )
                    # Keep capturing after the barge-in: the agent's tail (how
                    # long it keeps talking) is exactly what the yield metric
                    # measures. Stop only when the agent signals it's done.
                    if transcript.final_seen.is_set():
                        break

            await self._run_agent_consume(_consume_frames, stream, transcript, transcription_queue)
            await _cancel_task(transcript_task)

            agent_seg.ended_at = time.time()
            agent_seg.transcript = transcript.assemble()
            if agent_seg.transcript:
                agent_span.set_attribute("xray.turn.transcript", agent_seg.transcript)

        if user_publish_task is not None:
            await user_publish_task
        if user_seg is not None:
            user_seg.ended_at = time.time()

        return agent_seg, _agent_response_for(agent_seg), user_seg

    def _begin_interruption(
        self,
        *,
        user_idx: int,
        user_turn: Turn,
        user_pcm: bytes,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
    ) -> tuple[_TurnSegment, asyncio.Task[None]]:
        """Stamp the user segment's start and kick off publishing its audio
        concurrently with the ongoing agent capture. The user span is emitted
        under the user turn's own baggage scope."""
        user_seg = _TurnSegment(
            role="user", idx=user_idx, key=user_turn.key, transcript=user_turn.text or ""
        )
        user_seg.started_at = time.time()

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

    async def _run_agent_consume(
        self,
        consume_frames: Callable[[], Awaitable[None]],
        stream: LkAudioStream,
        transcript: _AgentTranscript,
        transcription_queue: asyncio.Queue[LkTranscriptionSegment],
    ) -> None:
        """Run the frame-consume loop under the turn timeout, then tear the
        stream down and drain any late-arriving transcripts. Shared by the
        normal and barge-in agent captures."""
        try:
            # asyncio.wait_for caps the consume loop so a silent agent can't
            # hang the iterator forever; the inner `final_seen` short-circuits
            # as soon as the transcript flips final.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(consume_frames(), timeout=self.agent_turn_timeout_s)
        finally:
            await stream.aclose()
            _drain_pending(transcript, transcription_queue)

    def _write_mixdown(self, segments: list[_TurnSegment]) -> tuple[Path | None, float | None]:
        if not segments:
            return None, None
        mixdown_root = self.mixdown_dir or (self.cache_root / "replays")
        mixdown_root.mkdir(parents=True, exist_ok=True)
        out_path = mixdown_root / f"{self.replay_id}.wav"
        try:
            recording_t0 = write_stereo_mixdown(segments=segments, out_path=out_path)
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


def write_stereo_mixdown(*, segments: list[_TurnSegment], out_path: Path) -> float | None:
    """Write segments as a wall-clock-aligned stereo WAV: left = user,
    right = agent. Each segment is placed at its captured `started_at`
    offset from t0 (the earliest started_at across all segments). Gaps
    between segments become silence on both channels; if both channels
    have audio at the same offset (barge-in / overlapping speech), both
    channels carry their PCM verbatim.

    The legacy turn-sequential layout (silence-pad-the-opposite-channel,
    concat) is gone — VAD on the server reads the wall-clock-aligned
    file to derive turn boundaries (`turn_start_ms` / `voice_start_ms`
    in `replay_turns`).

    Returns ``t0`` — the Unix-epoch wall-clock of audio sample 0 — so the
    orchestrator can send it as the recording anchor. None when no audio
    was placed (empty WAV).
    """
    placed = [s for s in segments if s.pcm and s.started_at is not None]
    if not placed:
        # Empty WAV: header + zero data. Keeps callers from special-casing.
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(SAMPLE_WIDTH_BYTES)
            w.setframerate(SAMPLE_RATE)
        return None

    t0 = min(s.started_at for s in placed if s.started_at is not None)
    total_samples = 0
    for s in placed:
        if s.started_at is None:
            continue
        offset_samples = max(0, int((s.started_at - t0) * SAMPLE_RATE))
        seg_samples = len(s.pcm) // SAMPLE_WIDTH_BYTES
        total_samples = max(total_samples, offset_samples + seg_samples)

    left = bytearray(total_samples * SAMPLE_WIDTH_BYTES)
    right = bytearray(total_samples * SAMPLE_WIDTH_BYTES)

    for s in placed:
        if s.started_at is None:
            continue
        offset_bytes = max(0, int((s.started_at - t0) * SAMPLE_RATE)) * SAMPLE_WIDTH_BYTES
        match s.role:
            case "user":
                _mix_into(left, offset_bytes, s.pcm)
            case "agent":
                _mix_into(right, offset_bytes, s.pcm)
            case _:
                assert_never(s.role)

    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(SAMPLE_WIDTH_BYTES)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(_interleave_lr(left=bytes(left), right=bytes(right)))

    return t0


def write_live_mixdown(
    *,
    user_frames: list[tuple[float, bytes]],
    agent_frames: list[tuple[float, bytes]],
    out_path: Path,
) -> float | None:
    """Write a wall-clock-aligned stereo WAV (L = user mic, R = agent) for a
    live session. Each frame is ``(wall_clock_seconds, int16_pcm_bytes)``.

    Within a channel, frames are laid **sequentially** — back-to-back — rather
    than at each frame's raw arrival offset. LiveKit's ``AudioStream`` delivers
    *consecutive* audio frames in bursts (decoded ahead of real time), so many
    frames carry near-identical arrival timestamps; placing each at its arrival
    offset collapses the burst onto overlapping samples and garbles the channel
    (the bug that made replays sound distorted even though live playback, which
    is sequential, was clean). Each frame therefore goes at
    ``max(running_position, arrival_offset)``: a burst lays back-to-back with no
    overlap, while a genuine arrival gap (arrival past the running position)
    inserts silence so cross-channel timing — who spoke when — is preserved.

    Mirrors :func:`write_stereo_mixdown` but keyed on per-frame arrival times
    instead of per-turn segments, because a live run has no turn boundaries on
    the driver side (the server derives them via VAD from this file)."""
    user = [(t, pcm) for t, pcm in user_frames if pcm]
    agent = [(t, pcm) for t, pcm in agent_frames if pcm]
    if not user and not agent:
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(SAMPLE_WIDTH_BYTES)
            w.setframerate(SAMPLE_RATE)
        return None

    t0 = min(t for t, _pcm in [*user, *agent])
    user_placed, user_total = _place_live_frames(user, t0)
    agent_placed, agent_total = _place_live_frames(agent, t0)
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


def _place_live_frames(
    frames: list[tuple[float, bytes]], t0: float
) -> tuple[list[tuple[int, bytes]], int]:
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
