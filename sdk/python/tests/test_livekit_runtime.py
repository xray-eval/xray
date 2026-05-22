"""Unit tests for ``LiveKitRuntime`` with the LiveKit room I/O stubbed.

We never hit the network: ``lk_rtc`` / ``lk_api`` are stub modules
injected via the runtime's ``_lk_rtc`` / ``_lk_api`` fields. The fake
Room fires staged events from inside its ``connect`` coroutine so the
runtime's ``wait_for(agent_joined.wait())`` resolves immediately.
"""

from __future__ import annotations

import asyncio
import wave
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from xray import Conversation, Turn
from xray.conversation import RecordedAudio, TtsAudio
from xray.errors import AgentNotJoinedError, RuntimeBindError
from xray.runtime.livekit import (
    NUM_CHANNELS,
    SAMPLE_RATE,
    SAMPLE_WIDTH_BYTES,
    LiveKitRuntime,
    _TurnSegment,
    _upsample_2x_int16,
    write_stereo_mixdown,
)

# ─── Fakes ────────────────────────────────────────────────────────────


class _FakeRoom:
    def __init__(self, staged_events: list[tuple[str, tuple[Any, ...]]]) -> None:
        self._handlers: dict[str, list[Any]] = {}
        self._staged_events = staged_events
        self.local_participant = MagicMock()
        self.local_participant.set_metadata = AsyncMock(return_value=None)
        self.local_participant.publish_track = AsyncMock(return_value=MagicMock())
        self.disconnect = AsyncMock(return_value=None)

    def on(self, event: str, callback: Any = None) -> Any:
        if callback is None:

            def _decorator(cb: Any) -> Any:
                self._handlers.setdefault(event, []).append(cb)
                return cb

            return _decorator
        self._handlers.setdefault(event, []).append(callback)
        return callback

    def fire(self, event: str, *args: Any) -> None:
        for cb in self._handlers.get(event, []):
            cb(*args)

    async def connect(self, *_: Any, **__: Any) -> None:
        # Replay staged events now that the runtime's handlers are wired.
        for name, args in self._staged_events:
            self.fire(name, *args)


@dataclass
class _FakeRoomFactory:
    """Builds a single ``_FakeRoom`` per call, but holds the staged
    events that the room fires inside ``connect``."""

    staged_events: list[tuple[str, tuple[Any, ...]]] = field(
        default_factory=list[tuple[str, tuple[Any, ...]]]
    )
    rooms: list[_FakeRoom] = field(default_factory=list[_FakeRoom])

    def __call__(self) -> _FakeRoom:
        room = _FakeRoom(staged_events=self.staged_events)
        self.rooms.append(room)
        return room


@dataclass
class _FakeAudioFrame:
    data: bytes
    sample_rate: int
    num_channels: int
    samples_per_channel: int


class _FakeAudioSource:
    def __init__(self, sample_rate: int, num_channels: int) -> None:
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.captured: list[_FakeAudioFrame] = []

    async def capture_frame(self, frame: _FakeAudioFrame) -> None:
        self.captured.append(frame)


class _FakeLocalAudioTrack:
    @staticmethod
    def create_audio_track(name: str, source: _FakeAudioSource) -> Any:
        track = MagicMock(spec=["name", "source"])
        track.name = name
        track.source = source
        return track


class _FakeAudioStream:
    """Async-iterable that yields one event per frame attached to the
    given track via the ``_xray_frames`` attribute.

    Tests may also attach ``_xray_after_frame_callbacks`` — a list (same
    length as ``_xray_frames``) of optional zero-arg callables. After each
    frame is yielded, the corresponding callback (if any) fires. This
    lets a test fire a ``transcription_received`` room event DURING an
    agent turn rather than during the (pre-turn) connect step — which is
    what really happens in production and what the SDK's queue-draining
    logic correctly expects."""

    def __init__(self, track: Any, **_: Any) -> None:
        self.frames: list[bytes] = list(getattr(track, "_xray_frames", []))
        self.after_frame_callbacks: list[Any] = list(
            getattr(track, "_xray_after_frame_callbacks", [])
        )
        self.aclose = AsyncMock(return_value=None)

    def __aiter__(self) -> AsyncIterator[Any]:
        async def _gen() -> AsyncIterator[Any]:
            for i, f in enumerate(self.frames):
                event = MagicMock()
                event.frame = MagicMock()
                event.frame.data = f
                yield event
                if i < len(self.after_frame_callbacks):
                    cb = self.after_frame_callbacks[i]
                    if cb is not None:
                        cb()

        return _gen()


def _build_fake_lk_rtc(staged_events: list[tuple[str, tuple[Any, ...]]] | None = None) -> Any:
    rtc = MagicMock(name="lk_rtc")
    rtc.Room = _FakeRoomFactory(staged_events=staged_events or [])
    rtc.AudioSource = _FakeAudioSource
    rtc.AudioFrame = _FakeAudioFrame
    rtc.LocalAudioTrack = _FakeLocalAudioTrack
    rtc.AudioStream = _FakeAudioStream
    rtc.TrackPublishOptions = lambda: MagicMock()
    rtc.TrackSource = MagicMock()
    rtc.TrackSource.SOURCE_MICROPHONE = "microphone"
    rtc.TrackKind = MagicMock()
    rtc.TrackKind.KIND_AUDIO = "audio"
    rtc.RoomOptions = lambda: MagicMock()
    return rtc


def _build_fake_lk_api() -> Any:
    api = MagicMock(name="lk_api")
    token = MagicMock()
    token.with_identity.return_value = token
    token.with_grants.return_value = token
    token.to_jwt.return_value = "fake-jwt"
    api.AccessToken = MagicMock(return_value=token)
    api.VideoGrants = MagicMock()
    return api


def _stage_agent_join() -> tuple[str, tuple[Any, ...]]:
    agent = MagicMock()
    agent.identity = "agent-bot"
    return ("participant_connected", (agent,))


def _stage_agent_track(frames: list[bytes]) -> tuple[str, tuple[Any, ...]]:
    agent = MagicMock()
    agent.identity = "agent-bot"
    track = MagicMock()
    track.kind = "audio"
    track._xray_frames = frames
    return ("track_subscribed", (track, MagicMock(), agent))


def _stage_transcription_final(text: str) -> tuple[str, tuple[Any, ...]]:
    agent = MagicMock()
    agent.identity = "agent-bot"
    seg = MagicMock()
    seg.text = text
    seg.final = True
    return ("transcription_received", ([seg], agent, MagicMock()))


def _make_silence_pcm(ms: int) -> bytes:
    sample_count = SAMPLE_RATE * ms // 1000
    return b"\x00\x00" * sample_count


def _write_recorded_wav(path: Path, ms: int = 40) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(NUM_CHANNELS)
        w.setsampwidth(SAMPLE_WIDTH_BYTES)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(_make_silence_pcm(ms))


def _runtime(
    tmp_path: Path,
    lk_rtc: Any,
    lk_api: Any,
    openai_tts: Any | None = None,
) -> LiveKitRuntime:
    rt = LiveKitRuntime(
        url="wss://fake",
        api_key="ak",
        api_secret="sk",
        room="room-1",
        cache_root=tmp_path / "cache",
        mixdown_dir=tmp_path / "mix",
        _lk_rtc=lk_rtc,
        _lk_api=lk_api,
        _openai_tts=openai_tts,
    )
    rt.bind(replay_id="rep-1", conversation_hash="a" * 64)
    return rt


# ─── Tests ────────────────────────────────────────────────────────────


def test_bind_required_before_run():
    rt = LiveKitRuntime(url="x", api_key="k", api_secret="s", room="r")
    conv = Conversation(name="c", turns=[Turn.user("hi")])
    with pytest.raises(RuntimeBindError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "driver_aborted"


def test_upsample_2x_doubles_sample_count():
    pcm = b"\x00\x10" * 100  # 100 samples
    out = _upsample_2x_int16(pcm)
    assert len(out) == len(pcm) * 2


def test_write_stereo_mixdown_round_trips(tmp_path: Path):
    seg = _TurnSegment(role="user", idx=0, key="u0", started_at=0.0)
    seg.pcm.extend(_make_silence_pcm(40))
    out = tmp_path / "out.wav"
    write_stereo_mixdown(segments=[seg], out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getframerate() == SAMPLE_RATE
        assert w.getsampwidth() == SAMPLE_WIDTH_BYTES


def test_write_stereo_mixdown_wall_clock_aligned(tmp_path: Path):
    """Segments placed at their wall-clock offsets, with silence padding
    between. Agent starts 0.5s after t0; total span = 1s (agent 0.5–1.0s)."""
    user = _TurnSegment(role="user", idx=0, key="u0", started_at=10.0)
    user.pcm.extend(_make_silence_pcm(200))  # 200ms
    agent = _TurnSegment(role="agent", idx=1, key="a0", started_at=10.5)
    agent.pcm.extend(_make_silence_pcm(500))  # 500ms

    out = tmp_path / "wall_clock.wav"
    write_stereo_mixdown(segments=[user, agent], out_path=out)

    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        # t0 = 10.0, span = max(10.0+0.2, 10.5+0.5) - 10.0 = 1.0s = 48000 frames
        assert w.getnframes() == SAMPLE_RATE


def test_write_stereo_mixdown_handles_empty_segments(tmp_path: Path):
    """All-silent input: produces a valid empty stereo WAV (header only)."""
    out = tmp_path / "empty.wav"
    write_stereo_mixdown(segments=[], out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getnframes() == 0


def test_runtime_publishes_recorded_user_turn_and_produces_mixdown(tmp_path: Path):
    wav_path = tmp_path / "u0.wav"
    _write_recorded_wav(wav_path, ms=40)

    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)

    conv = Conversation(
        name="c",
        turns=[Turn.user("hi", key="u0", audio=RecordedAudio(path=str(wav_path)))],
    )

    result = asyncio.run(rt.run(conv))

    room = rtc.Room.rooms[0]
    assert room.local_participant.publish_track.await_count == 1
    assert result.full_audio_path is not None
    out_path = Path(result.full_audio_path)
    assert out_path.exists() and out_path.stat().st_size > 44  # WAV header is 44 B
    with wave.open(str(out_path), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getframerate() == SAMPLE_RATE
        assert w.getnframes() == SAMPLE_RATE * 40 // 1000


def test_runtime_captures_agent_turn_via_transcription(tmp_path: Path):
    wav_path = tmp_path / "u0.wav"
    _write_recorded_wav(wav_path, ms=40)

    track_event = _stage_agent_track([_make_silence_pcm(20), _make_silence_pcm(20)])
    track_obj = track_event[1][0]
    transcription_event = _stage_transcription_final("confirmed at 7pm")
    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            track_event,
        ]
    )

    # Fire the transcription_received event AFTER the first audio frame is
    # yielded (during the agent turn), not at connect-time. This mirrors
    # real Gemini Live behavior: transcripts arrive while the agent emits
    # audio, not before. The SDK now drains stale queue entries at the
    # start of each agent turn (regression: a final segment that arrived
    # between turns would satisfy the next turn's `final_seen` event in
    # microseconds).
    def _fire_transcription() -> None:
        rtc.Room.rooms[0].fire(transcription_event[0], *transcription_event[1])

    track_obj._xray_after_frame_callbacks = [_fire_transcription, None]
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 2.0

    conv = Conversation(
        name="c",
        turns=[
            Turn.user("hello", key="u0", audio=RecordedAudio(path=str(wav_path))),
            Turn.agent(key="a0"),
        ],
    )

    result = asyncio.run(rt.run(conv))
    assert len(result.responses) == 2
    assert "confirmed at 7pm" in result.responses[1].transcript
    assert result.full_audio_path is not None
    out = Path(result.full_audio_path)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        # Wall-clock-aligned mixdown: file spans from t0 (earliest segment
        # `started_at`) to the latest `started_at + duration`. In this test
        # the turns run back-to-back at ~test-machine speed, so the file
        # length is at least the agent turn (40ms = 1920 frames at 48kHz)
        # and at most user+agent (80ms = 3840 frames). The legacy
        # turn-sequential layout was always exactly 80ms; the new layout
        # depends on real timing.
        nframes = w.getnframes()
        assert SAMPLE_RATE * 40 // 1000 <= nframes <= SAMPLE_RATE * 80 // 1000


def test_runtime_drains_stale_transcripts_between_agent_turns(tmp_path: Path):
    """A ``final=True`` transcription segment that arrives between two
    agent turns (e.g. delayed `conversation_item_added` from Gemini Live
    after the prior turn's audio ended) must NOT satisfy the next agent
    turn's ``final_seen`` event. Without the queue-drain on entry to
    ``_capture_agent_turn``, the stale segment would end the next turn
    in microseconds and the recording would stop before the agent emits
    any audio for it (the bug surfaced in
    ``examples/livekit-voice-agent/`` as a 2-turn server-derived VAD
    output for a 3-turn conversation)."""

    wav_path = tmp_path / "u0.wav"
    _write_recorded_wav(wav_path, ms=40)

    track_event = _stage_agent_track([_make_silence_pcm(20)])
    track_obj = track_event[1][0]
    # Fire a final segment for the FIRST agent turn during its frame play.
    first_final = _stage_transcription_final("first")
    # The stale segment for the user turn — fires during user playback
    # (between agent turn 0 and agent turn 2). Without the fix, agent
    # turn 2 picks this up as its own and ends instantly.
    stale = _stage_transcription_final("stale")

    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            track_event,
        ]
    )

    def _fire_first() -> None:
        rtc.Room.rooms[0].fire(first_final[0], *first_final[1])

    track_obj._xray_after_frame_callbacks = [_fire_first]

    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 0.3

    # Wrap _play_user_turn to fire the stale event AFTER the user turn
    # plays — between agent turns 0 and 2 — matching the real-world
    # window when Gemini Live's delayed `conversation_item_added` fires.
    original_play_user_turn = rt._play_user_turn

    async def _wrapped_play_user_turn(**kw: Any) -> Any:
        result = await original_play_user_turn(**kw)
        rtc.Room.rooms[0].fire(stale[0], *stale[1])
        return result

    rt._play_user_turn = _wrapped_play_user_turn

    conv = Conversation(
        name="c",
        turns=[
            Turn.agent(key="a0"),
            Turn.user("hi", key="u0", audio=RecordedAudio(path=str(wav_path))),
            Turn.agent(key="a1"),
        ],
    )

    result = asyncio.run(rt.run(conv))
    # Agent turn 0 should capture "first".
    assert "first" in result.responses[0].transcript
    # Agent turn 2 must NOT inherit "stale" — it should drain the queue
    # on entry and (since no new segments arrive for it) time out with
    # an empty transcript.
    assert "stale" not in result.responses[2].transcript


def test_runtime_raises_agent_not_joined_on_timeout(tmp_path: Path):
    # No staged events ⇒ agent_joined.wait() times out.
    rtc = _build_fake_lk_rtc(staged_events=[])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_join_timeout_s = 0.05

    conv = Conversation(name="c", turns=[Turn.user("hi")])

    with pytest.raises(AgentNotJoinedError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "agent_not_joined"
    assert exc.value.room == "room-1"


def test_user_turn_emits_xray_turn_span(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The driver must emit one ``xray.turn`` span per user turn with
    role=user, the authored transcript, and the turn idx/key. This is
    what makes user turns show up in the replay UI alongside agent
    turns — without it the user side stays invisible."""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    import xray.runtime.livekit as livekit_mod

    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    # Module-level `_TRACER` was bound to the default no-op provider at
    # import time; rebind to the test provider so emitted spans land in
    # the in-memory exporter.
    monkeypatch.setattr(livekit_mod, "_TRACER", provider.get_tracer("xray-py-driver", "0.0.1"))

    wav_path = tmp_path / "u0.wav"
    _write_recorded_wav(wav_path, ms=40)

    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)

    conv = Conversation(
        name="c",
        turns=[Turn.user("hello there", key="u0", audio=RecordedAudio(path=str(wav_path)))],
    )
    asyncio.run(rt.run(conv))

    finished = exporter.get_finished_spans()
    turn_spans = [s for s in finished if s.name == "xray.turn"]
    assert len(turn_spans) == 1, f"expected one xray.turn span, got {len(turn_spans)}"
    span = turn_spans[0]
    attrs = span.attributes or {}
    assert attrs.get("xray.turn.role") == "user"
    assert attrs.get("xray.turn.idx") == 0
    assert attrs.get("xray.turn.transcript") == "hello there"
    assert attrs.get("xray.turn.key") == "u0"
    # Span timing brackets the audio publish — both endpoints set.
    assert span.start_time is not None
    assert span.end_time is not None
    assert span.end_time >= span.start_time


def test_driver_emits_xray_turn_for_user_and_agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The driver is the sole emitter of ``replay_turns`` rows. For a
    user+agent conversation it must emit one ``xray.turn`` span per
    turn — role=user for the played audio, role=agent for the captured
    response — with monotonically increasing idx values, so the server
    PK ``(replay_id, idx)`` doesn't collide with anything an agent
    worker might emit on its own.
    """
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    import xray.runtime.livekit as livekit_mod

    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(livekit_mod, "_TRACER", provider.get_tracer("xray-py-driver", "0.0.1"))

    wav_path = tmp_path / "u0.wav"
    _write_recorded_wav(wav_path, ms=40)

    track_event = _stage_agent_track([_make_silence_pcm(20), _make_silence_pcm(20)])
    track_obj = track_event[1][0]
    transcription_event = _stage_transcription_final("confirmed at 7pm")
    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            track_event,
        ]
    )

    # Fire the transcription during the agent turn (after the first frame
    # is yielded). Pre-turn fire would be drained by the stale-queue
    # guard in `_capture_agent_turn`.
    def _fire_transcription() -> None:
        rtc.Room.rooms[0].fire(transcription_event[0], *transcription_event[1])

    track_obj._xray_after_frame_callbacks = [_fire_transcription, None]
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 2.0

    conv = Conversation(
        name="c",
        turns=[
            Turn.user("hello", key="u0", audio=RecordedAudio(path=str(wav_path))),
            Turn.agent(key="a0"),
        ],
    )
    asyncio.run(rt.run(conv))

    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "xray.turn"]
    assert len(turn_spans) == 2, f"expected 2 xray.turn spans, got {len(turn_spans)}"
    user_attrs = (
        next(
            (
                s.attributes
                for s in turn_spans
                if (s.attributes or {}).get("xray.turn.role") == "user"
            ),
            None,
        )
        or {}
    )
    agent_attrs = (
        next(
            (
                s.attributes
                for s in turn_spans
                if (s.attributes or {}).get("xray.turn.role") == "agent"
            ),
            None,
        )
        or {}
    )
    assert user_attrs.get("xray.turn.idx") == 0
    assert user_attrs.get("xray.turn.transcript") == "hello"
    assert user_attrs.get("xray.turn.key") == "u0"
    assert agent_attrs.get("xray.turn.idx") == 1
    assert agent_attrs.get("xray.turn.transcript") == "confirmed at 7pm"
    assert agent_attrs.get("xray.turn.key") == "a0"
    # Distinct idx values rule out the (replay_id, idx) PK collision.
    assert user_attrs.get("xray.turn.idx") != agent_attrs.get("xray.turn.idx")


def test_tts_path_uses_openai_injection_and_caches(tmp_path: Path):
    calls: list[dict[str, Any]] = []

    async def _fake_tts(text: str, voice: str, model: str) -> bytes:
        calls.append({"text": text, "voice": voice, "model": model})
        return b"\x00\x00" * 480  # 20 ms of 24 kHz silence (480 samples)

    rtc1 = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api1 = _build_fake_lk_api()
    rt1 = _runtime(tmp_path, rtc1, api1, openai_tts=_fake_tts)

    conv = Conversation(
        name="conv-x",
        turns=[Turn.user("hello world", key="u0", audio=TtsAudio())],
    )

    asyncio.run(rt1.run(conv))
    assert len(calls) == 1

    # Second run with a fresh runtime hitting the same cache_root must
    # NOT call TTS again — the cached WAV satisfies the request.
    rtc2 = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api2 = _build_fake_lk_api()
    rt2 = _runtime(tmp_path, rtc2, api2, openai_tts=_fake_tts)
    rt2.replay_id = "rep-2"

    asyncio.run(rt2.run(conv))
    assert len(calls) == 1
