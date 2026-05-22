"""LiveKit runtime — v1 implementation.

Joins the dev's LiveKit room as the user-side participant. Publishes
each user turn as a real audio track, captures the agent's audio +
transcripts, and tees both into a single stereo WAV mixdown (left =
user, right = agent) at ``~/.cache/xray-py/replays/<replay>.wav``.

User-side audio is sourced from a :class:`RecordedAudio` (WAV on disk)
or a :class:`TtsAudio` (synthesized via OpenAI TTS and cached at
``~/.cache/xray-py/<conversation_hash>/<sha256(text,voice,model)[:16]>.wav``).

The dev's OpenAI key stays in *their* process: the SDK calls OpenAI
directly when synthesizing, never via xray.

Type safety: every LiveKit object reaches us through a Protocol from
``_livekit_types`` — no ``Any`` for foreign types. Branches over the
``AudioRef`` discriminated union and the ``Role`` Literal end in
``assert_never``.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import hashlib
import importlib
import json
import logging
import os
import time
import wave
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import ClassVar, Final

import httpx
from opentelemetry import baggage, context, trace
from typing_extensions import assert_never, override

from xray.conversation import (
    AgentResponse,
    Conversation,
    RecordedAudio,
    Role,
    TtsAudio,
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
    OpenAiTtsFn,
)
from xray.runtime.base import Runtime, RuntimeResult

logger = logging.getLogger(__name__)

# LiveKit's default is 48 kHz mono. Matching the source rate avoids an
# in-process resampler dep (audioop is deprecated on 3.13+).
SAMPLE_RATE: Final[int] = 48000
NUM_CHANNELS: Final[int] = 1
SAMPLE_WIDTH_BYTES: Final[int] = 2  # int16
FRAME_MS: Final[int] = 20
SAMPLES_PER_FRAME: Final[int] = SAMPLE_RATE * FRAME_MS // 1000

# OpenAI TTS returns raw int16 PCM at 24 kHz when response_format='pcm'.
# We linearly upsample to 48 kHz so it matches the LiveKit AudioSource.
_OPENAI_TTS_INPUT_RATE: Final[int] = 24000


# Tracer used by the driver to emit per-user-turn ``xray.turn`` spans.
# The XrayBaggageSpanProcessor (installed by the orchestrator before
# ``runtime.run``) lifts the replay-scope baggage onto these spans so
# the OTLP receiver can route them to ``replay_turns``.
_TRACER = trace.get_tracer("xray-py-driver", "0.0.1")


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


@dataclass
class LiveKitRuntime(Runtime):
    """Joins a LiveKit room as the user-side test driver. Plays per-turn
    audio (recorded or OpenAI-TTS), captures the agent's transcripts +
    audio, and writes one stereo WAV mixdown per replay.

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

    # Injection points for tests. None ⇒ load the real packages.
    _lk_rtc: LkRtcModule | None = None
    _lk_api: LkApiModule | None = None
    _openai_tts: OpenAiTtsFn | None = None

    # Populated by the orchestrator before ``run`` is called.
    replay_id: str | None = None
    conversation_hash: str | None = None

    OPENAI_API_URL: ClassVar[str] = "https://api.openai.com/v1/audio/speech"
    DEFAULT_OPENAI_TTS_MODEL: ClassVar[str] = "gpt-4o-mini-tts"
    DEFAULT_OPENAI_TTS_VOICE: ClassVar[str] = "alloy"

    def bind(
        self,
        *,
        replay_id: str,
        conversation_hash: str,
    ) -> None:
        """Called by the orchestrator once it knows the Replay's id."""
        self.replay_id = replay_id
        self.conversation_hash = conversation_hash

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

        mixdown_path = self._write_mixdown(segments)
        return RuntimeResult(
            responses=responses,
            full_audio_path=str(mixdown_path) if mixdown_path is not None else None,
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
        conv_hash = self.conversation_hash or "unbound"
        for idx, turn in enumerate(conversation.turns):
            async with _scoped_turn(idx, key=turn.key):
                match turn.role:
                    case "user":
                        user_seg = await self._play_user_turn(
                            conv_hash=conv_hash,
                            idx=idx,
                            turn=turn,
                            audio_source=audio_source,
                            lk_rtc=lk_rtc,
                        )
                        segments.append(user_seg)
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
        return segments, responses

    async def _play_user_turn(
        self,
        *,
        conv_hash: str,
        idx: int,
        turn: Turn,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
    ) -> _TurnSegment:
        pcm = await self._load_or_synth_user_pcm(conv_hash=conv_hash, idx=idx, turn=turn)
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
        # `agent_track_event` is one-time (track subscription is room-scoped,
        # not turn-scoped). Only wait on it if we don't yet have a track —
        # otherwise the wait would return immediately on turn 2+ and the
        # configured `agent_turn_timeout_s` would silently no-op.
        if not agent_audio_track_holder:
            try:
                await asyncio.wait_for(agent_track_event.wait(), timeout=self.agent_turn_timeout_s)
            except TimeoutError as e:
                raise AgentNotJoinedError(self.room, self.agent_turn_timeout_s) from e
        track = agent_audio_track_holder[-1]
        stream = lk_rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)

        # A stale `final=True` segment left in the queue from the prior
        # agent turn would satisfy this turn's `final_seen` on the first
        # drainer iteration and end the turn before any new audio is
        # captured. Drop pre-turn segments before installing the drainer.
        while not transcription_queue.empty():
            with contextlib.suppress(asyncio.QueueEmpty):
                transcription_queue.get_nowait()

        segment = _TurnSegment(role="agent", idx=idx, key=turn.key)
        transcript_buf: list[str] = []
        final_seen = asyncio.Event()

        async def _drain_transcripts() -> None:
            while not final_seen.is_set():
                seg = await transcription_queue.get()
                transcript_buf.append(seg.text)
                if seg.final:
                    final_seen.set()
                    return

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
            transcript_task = asyncio.create_task(_drain_transcripts())
            deadline = time.time() + self.agent_turn_timeout_s

            async def _consume_frames() -> None:
                async for event in stream:
                    segment.pcm.extend(bytes(event.frame.data))
                    if final_seen.is_set():
                        break

            try:
                # asyncio.wait_for caps the consume loop so a silent agent
                # can't hang the iterator forever; the inner `final_seen`
                # short-circuits as soon as the transcript flips final.
                remaining = max(0.0, deadline - time.time())
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(_consume_frames(), timeout=remaining)
            finally:
                await stream.aclose()
                # Drain anything in the queue before tearing down the task —
                # segments may have arrived before the task got a turn on the
                # loop (common when the stream finishes synchronously, as in
                # the test mocks).
                while not transcription_queue.empty():
                    seg = transcription_queue.get_nowait()
                    transcript_buf.append(seg.text)
                    if seg.final:
                        final_seen.set()
                if not transcript_task.done():
                    transcript_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await transcript_task

            segment.ended_at = time.time()
            segment.transcript = " ".join(transcript_buf).strip()
            if segment.transcript:
                span.set_attribute("xray.turn.transcript", segment.transcript)

        return segment, AgentResponse(
            transcript=segment.transcript,
            duration_ms=int((segment.ended_at - segment.started_at) * 1000),
        )

    def _write_mixdown(self, segments: list[_TurnSegment]) -> Path | None:
        if not segments:
            return None
        mixdown_root = self.mixdown_dir or (self.cache_root / "replays")
        mixdown_root.mkdir(parents=True, exist_ok=True)
        out_path = mixdown_root / f"{self.replay_id}.wav"
        try:
            write_stereo_mixdown(segments=segments, out_path=out_path)
        except OSError as e:
            raise MixdownError(f"could not write mixdown WAV: {e}") from e
        return out_path

    async def _load_or_synth_user_pcm(self, *, conv_hash: str, idx: int, turn: Turn) -> bytes:
        match turn.audio:
            case RecordedAudio(path=path):
                return _read_wav_as_pcm48k_mono(Path(path), turn_idx=idx)
            case TtsAudio(voice_id=voice_id):
                return await self._synth_tts_pcm(
                    conv_hash=conv_hash, idx=idx, turn=turn, voice_id=voice_id
                )
            case None:
                # No explicit audio → fall back to TTS. The missing-text
                # case is raised inside _synth_tts_pcm.
                return await self._synth_tts_pcm(
                    conv_hash=conv_hash, idx=idx, turn=turn, voice_id=None
                )
            case _:
                assert_never(turn.audio)

    async def _synth_tts_pcm(
        self, *, conv_hash: str, idx: int, turn: Turn, voice_id: str | None
    ) -> bytes:
        if turn.text is None:
            raise AudioMissingError(
                f"turn {idx}: TTS requested but no text provided",
                turn_idx=idx,
            )
        api_key = os.environ.get("OPENAI_API_KEY")
        # Tests inject ``_openai_tts`` directly so the OpenAI key check
        # is skipped — otherwise CI would need OPENAI_API_KEY just to run
        # unit tests that never hit the network.
        if not api_key and self._openai_tts is None:
            raise AudioMissingError(
                f"turn {idx}: TTS requested but OPENAI_API_KEY is not set",
                turn_idx=idx,
            )
        voice = voice_id or os.environ.get("OPENAI_TTS_VOICE", self.DEFAULT_OPENAI_TTS_VOICE)
        model = os.environ.get("OPENAI_TTS_MODEL", self.DEFAULT_OPENAI_TTS_MODEL)
        return await self._tts_to_cached_pcm(
            conv_hash=conv_hash, text=turn.text, voice=voice, model=model, api_key=api_key or ""
        )

    async def _tts_to_cached_pcm(
        self, *, conv_hash: str, text: str, voice: str, model: str, api_key: str
    ) -> bytes:
        cache_dir = self.cache_root / conv_hash
        cache_dir.mkdir(parents=True, exist_ok=True)
        fingerprint = hashlib.sha256(
            json.dumps(
                {"text": text, "voice": voice, "model": model},
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()[:16]
        cached = cache_dir / f"{fingerprint}.wav"
        if cached.exists():
            return _read_wav_as_pcm48k_mono(cached, turn_idx=None)

        if self._openai_tts is not None:
            pcm_24k = await self._openai_tts(text=text, voice=voice, model=model)
        else:
            pcm_24k = await _openai_tts_pcm(text=text, voice=voice, model=model, api_key=api_key)
        pcm_48k = _upsample_2x_int16(pcm_24k)
        _write_pcm_as_wav(pcm_48k, cached, sample_rate=SAMPLE_RATE)
        return pcm_48k

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
        attributes = encode_attribute(
            replay_id=self.replay_id,
            conversation_hash=self.conversation_hash,
        )
        builder = lk_api.AccessToken(self.api_key, self.api_secret)
        builder = builder.with_identity(self.identity)
        builder = builder.with_grants(lk_api.VideoGrants(room_join=True, room=self.room))
        if hasattr(builder, "with_attributes"):
            builder = builder.with_attributes(attributes)
        return builder.to_jwt()

    def _load_livekit(self) -> tuple[LkRtcModule, LkApiModule]:
        # Loaded via importlib so pyright doesn't try to resolve `livekit`
        # at type-check time — the Protocols in `_livekit_types` are the
        # static contract; `isinstance` against them is the runtime gate.
        # CI therefore doesn't need `pip install ...[livekit]`.
        if self._lk_rtc is not None and self._lk_api is not None:
            return self._lk_rtc, self._lk_api
        try:
            lk_rtc_mod: object = importlib.import_module("livekit.rtc")
            lk_api_mod: object = importlib.import_module("livekit.api")
        except ImportError as e:
            raise LiveKitDependencyError(
                "LiveKitRuntime requires `pip install xray-py[livekit]`."
            ) from e
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

    @override
    async def aclose(self) -> None:
        return None


def _read_wav_as_pcm48k_mono(path: Path, *, turn_idx: int | None) -> bytes:
    """Read a WAV file and return its PCM bytes. Requires 48 kHz / mono /
    16-bit signed so we don't need a runtime resampler."""
    if not path.exists():
        raise AudioMissingError(f"recorded audio not found: {path}", turn_idx=turn_idx)
    try:
        with wave.open(str(path), "rb") as w:
            sample_rate = w.getframerate()
            channels = w.getnchannels()
            sample_width = w.getsampwidth()
            frame_count = w.getnframes()
            pcm = w.readframes(frame_count)
    except wave.Error as e:
        raise AudioMissingError(f"invalid WAV file at {path}: {e}", turn_idx=turn_idx) from e
    if sample_rate != SAMPLE_RATE or channels != NUM_CHANNELS or sample_width != 2:
        raise AudioMissingError(
            f"recorded audio at {path} must be 48000 Hz, 1 channel, 16-bit (got "
            f"{sample_rate} Hz, {channels} ch, {sample_width * 8}-bit). Re-encode with "
            "`ffmpeg -i in.wav -ar 48000 -ac 1 -sample_fmt s16 out.wav`.",
            turn_idx=turn_idx,
        )
    return pcm


def _write_pcm_as_wav(pcm: bytes, path: Path, *, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(NUM_CHANNELS)
        w.setsampwidth(SAMPLE_WIDTH_BYTES)
        w.setframerate(sample_rate)
        w.writeframes(pcm)


def _upsample_2x_int16(pcm: bytes) -> bytes:
    """Cheap 2x linear-interpolation upsampler. Sufficient for voice
    intelligibility — we avoid pulling in scipy/audioop just for this."""
    src = array.array("h")
    src.frombytes(pcm)
    n = len(src)
    if n == 0:
        return b""
    out = array.array("h", bytes(n * 4))  # 2x samples, 2 bytes each
    out[0::2] = src
    # Interpolated midpoint between consecutive samples; last midpoint
    # repeats the final sample so the output length stays exactly 2x.
    out[1 : 2 * (n - 1) : 2] = array.array(
        "h", [(a + b) // 2 for a, b in zip(src, src[1:], strict=False)]
    )
    out[-1] = src[-1]
    return out.tobytes()


async def _openai_tts_pcm(
    *,
    text: str,
    voice: str,
    model: str,
    api_key: str,
) -> bytes:
    """Call OpenAI's /v1/audio/speech with response_format='pcm'. Returns
    raw int16 PCM at 24 kHz."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            LiveKitRuntime.OPENAI_API_URL,
            json={
                "model": model,
                "voice": voice,
                "input": text,
                "response_format": "pcm",
            },
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        if response.status_code >= 400:
            raise AudioMissingError(
                f"OpenAI TTS returned HTTP {response.status_code}: {response.text[:200]}"
            )
        return response.content


def write_stereo_mixdown(*, segments: list[_TurnSegment], out_path: Path) -> None:
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
    """
    placed = [s for s in segments if s.pcm and s.started_at is not None]
    if not placed:
        # Empty WAV: header + zero data. Keeps callers from special-casing.
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(SAMPLE_WIDTH_BYTES)
            w.setframerate(SAMPLE_RATE)
        return

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
