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

from xray import Conversation, Turn, expect_agent_turn
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
    given track via the ``_xray_frames`` attribute."""

    def __init__(self, track: Any, **_: Any) -> None:
        self.frames: list[bytes] = list(getattr(track, "_xray_frames", []))
        self.aclose = AsyncMock(return_value=None)

    def __aiter__(self) -> AsyncIterator[Any]:
        async def _gen() -> AsyncIterator[Any]:
            for f in self.frames:
                event = MagicMock()
                event.frame = MagicMock()
                event.frame.data = f
                yield event

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
    rt.bind(replay_id="rep-1", conversation_id="conv-1", conversation_version="v1")
    return rt


# ─── Tests ────────────────────────────────────────────────────────────


def test_bind_required_before_run():
    rt = LiveKitRuntime(url="x", api_key="k", api_secret="s", room="r")
    conv = Conversation(id="c", turns=[Turn.user("hi")])
    with pytest.raises(RuntimeBindError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "sdk_aborted"


def test_upsample_2x_doubles_sample_count():
    pcm = b"\x00\x10" * 100  # 100 samples
    out = _upsample_2x_int16(pcm)
    assert len(out) == len(pcm) * 2


def test_write_stereo_mixdown_round_trips(tmp_path: Path):
    seg = _TurnSegment(role="user", idx=0, key="u0")
    seg.pcm.extend(_make_silence_pcm(40))
    out = tmp_path / "out.wav"
    write_stereo_mixdown(segments=[seg], out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getframerate() == SAMPLE_RATE
        assert w.getsampwidth() == SAMPLE_WIDTH_BYTES


def test_runtime_publishes_recorded_user_turn_and_produces_mixdown(tmp_path: Path):
    wav_path = tmp_path / "u0.wav"
    _write_recorded_wav(wav_path, ms=40)

    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)

    conv = Conversation(
        id="c",
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

    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            _stage_agent_track([_make_silence_pcm(20), _make_silence_pcm(20)]),
            _stage_transcription_final("confirmed at 7pm"),
        ]
    )
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 2.0

    conv = Conversation(
        id="c",
        turns=[
            Turn.user("hello", key="u0", audio=RecordedAudio(path=str(wav_path))),
            expect_agent_turn(key="a0"),
        ],
    )

    result = asyncio.run(rt.run(conv))
    assert len(result.responses) == 2
    assert "confirmed at 7pm" in result.responses[1].transcript
    assert result.full_audio_path is not None
    out = Path(result.full_audio_path)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        # 40 ms user + 40 ms agent = 80 ms = 3840 frames at 48k.
        assert w.getnframes() == SAMPLE_RATE * 80 // 1000


def test_runtime_raises_agent_not_joined_on_timeout(tmp_path: Path):
    # No staged events ⇒ agent_joined.wait() times out.
    rtc = _build_fake_lk_rtc(staged_events=[])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_join_timeout_s = 0.05

    conv = Conversation(id="c", turns=[Turn.user("hi")])

    with pytest.raises(AgentNotJoinedError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "agent_not_joined"
    assert exc.value.room == "room-1"


def test_tts_path_uses_openai_injection_and_caches(tmp_path: Path):
    calls: list[dict[str, Any]] = []

    async def _fake_tts(text: str, voice: str, model: str) -> bytes:
        calls.append({"text": text, "voice": voice, "model": model})
        return b"\x00\x00" * 480  # 20 ms of 24 kHz silence (480 samples)

    rtc1 = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api1 = _build_fake_lk_api()
    rt1 = _runtime(tmp_path, rtc1, api1, openai_tts=_fake_tts)

    conv = Conversation(
        id="conv-x",
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
