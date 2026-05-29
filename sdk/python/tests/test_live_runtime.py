"""Unit tests for ``LiveKitLiveRuntime`` with LiveKit + mic I/O stubbed.

No network, no real microphone: ``lk_rtc`` / ``lk_api`` are stub modules
and the mic is a fake async-iterable injected via ``_mic_factory``. The
session is open-ended, so each test drives ``run`` as a task and calls
``request_stop`` to end it (the SIGINT path ``run_live`` wires up).
"""

from __future__ import annotations

import asyncio
import wave
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from xray import Conversation
from xray.errors import AgentNotJoinedError, RuntimeBindError
from xray.runtime.livekit import (
    NUM_CHANNELS,
    SAMPLE_RATE,
    SAMPLE_WIDTH_BYTES,
    write_live_mixdown,
)
from xray.runtime.livekit_live import LiveKitLiveRuntime

# ─── Fakes ────────────────────────────────────────────────────────────


class _FakeRoom:
    def __init__(self, staged_events: list[tuple[str, tuple[Any, ...]]]) -> None:
        self._handlers: dict[str, list[Any]] = {}
        self._staged_events = staged_events
        self.local_participant = MagicMock()
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
        for name, args in self._staged_events:
            self.fire(name, *args)


class _FakeRoomFactory:
    def __init__(self, staged_events: list[tuple[str, tuple[Any, ...]]]) -> None:
        self.staged_events = staged_events
        self.rooms: list[_FakeRoom] = []

    def __call__(self) -> _FakeRoom:
        room = _FakeRoom(staged_events=self.staged_events)
        self.rooms.append(room)
        return room


class _FakeAudioFrame:
    def __init__(
        self, *, data: bytes, sample_rate: int, num_channels: int, samples_per_channel: int
    ) -> None:
        self.data = data
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.samples_per_channel = samples_per_channel


class _FakeAudioSource:
    instances: list[_FakeAudioSource] = []

    def __init__(self, sample_rate: int, num_channels: int) -> None:
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.captured: list[_FakeAudioFrame] = []
        _FakeAudioSource.instances.append(self)

    async def capture_frame(self, frame: _FakeAudioFrame) -> None:
        self.captured.append(frame)


class _FakeLocalAudioTrack:
    @staticmethod
    def create_audio_track(name: str, source: _FakeAudioSource) -> Any:
        track = MagicMock()
        track.name = name
        track.source = source
        return track


class _FakeAudioStream:
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


class _FakeMicStream:
    """Async-CM + async-iterable mirroring ``SoundDeviceMicStream``: yields
    its staged frames, then blocks until the context manager exits (the
    runtime closes it when its stop-event fires)."""

    def __init__(self, frames: list[bytes]) -> None:
        self._frames = frames
        self._closed = asyncio.Event()

    async def __aenter__(self) -> _FakeMicStream:
        return self

    async def __aexit__(self, *_: Any) -> None:
        self._closed.set()

    def __aiter__(self) -> AsyncIterator[bytes]:
        async def _gen() -> AsyncIterator[bytes]:
            for f in self._frames:
                yield f
            await self._closed.wait()

        return _gen()


def _fake_mic_factory(frames: list[bytes]) -> Any:
    def factory(*, sample_rate: int, frame_samples: int) -> _FakeMicStream:
        return _FakeMicStream(frames)

    return factory


class _FakeSpeaker:
    """Records frames handed to play(); stands in for the OS speaker."""

    def __init__(self) -> None:
        self.played: list[bytes] = []
        self.entered = False
        self.exited = False

    async def __aenter__(self) -> _FakeSpeaker:
        self.entered = True
        return self

    async def __aexit__(self, *_: Any) -> None:
        self.exited = True

    async def play(self, frame: bytes) -> None:
        self.played.append(frame)


def _fake_speaker_factory(sink: _FakeSpeaker) -> Any:
    def factory(*, sample_rate: int, channels: int) -> _FakeSpeaker:
        return sink

    return factory


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
    token.with_attributes.return_value = token
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


def _silence(ms: int) -> bytes:
    return b"\x00\x00" * (SAMPLE_RATE * ms // 1000)


def _runtime(
    tmp_path: Path,
    rtc: Any,
    api: Any,
    mic_frames: list[bytes],
    speaker: _FakeSpeaker | None = None,
) -> LiveKitLiveRuntime:
    rt = LiveKitLiveRuntime(
        url="wss://fake",
        api_key="ak",
        api_secret="sk",
        room="room-1",
        cache_root=tmp_path / "cache",
        mixdown_dir=tmp_path / "mix",
        _lk_rtc=rtc,
        _lk_api=api,
        _mic_factory=_fake_mic_factory(mic_frames),
        # Inject a fake speaker so tests never touch a real output device.
        _speaker_factory=_fake_speaker_factory(speaker or _FakeSpeaker()),
    )
    rt.bind(replay_id="rep-live-1", conversation_hash="a" * 64)
    return rt


# ─── Tests ────────────────────────────────────────────────────────────


def test_bind_required_before_run():
    rt = LiveKitLiveRuntime(url="x", api_key="k", api_secret="s", room="r")
    conv = Conversation(name="live", turns=[], live=True)
    with pytest.raises(RuntimeBindError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "driver_aborted"


@pytest.mark.asyncio
async def test_records_mic_and_agent_into_stereo_mixdown(tmp_path: Path):
    _FakeAudioSource.instances = []
    rtc = _build_fake_lk_rtc(
        staged_events=[_stage_agent_join(), _stage_agent_track([_silence(20), _silence(20)])]
    )
    api = _build_fake_lk_api()
    mic_frames = [_silence(20), _silence(20), _silence(20)]
    rt = _runtime(tmp_path, rtc, api, mic_frames)
    conv = Conversation(name="live", turns=[], live=True)

    task = asyncio.create_task(rt.run(conv))
    await asyncio.sleep(0.05)
    rt.request_stop()
    result = await asyncio.wait_for(task, timeout=3.0)

    # User mic frames were published to the LiveKit audio source.
    assert len(_FakeAudioSource.instances) == 1
    assert len(_FakeAudioSource.instances[0].captured) == len(mic_frames)

    room = rtc.Room.rooms[0]
    assert room.local_participant.publish_track.await_count == 1
    assert room.disconnect.await_count == 1

    assert result.full_audio_path is not None
    out = Path(result.full_audio_path)
    assert out.exists()
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getframerate() == SAMPLE_RATE
        assert w.getnframes() > 0


@pytest.mark.asyncio
async def test_agent_audio_played_to_speaker(tmp_path: Path):
    """Every captured agent frame must also be played to the speaker — this
    is what lets the user actually hear the agent and converse."""
    agent_pcm = [_silence(20), _silence(20), _silence(20)]
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join(), _stage_agent_track(agent_pcm)])
    api = _build_fake_lk_api()
    speaker = _FakeSpeaker()
    rt = _runtime(tmp_path, rtc, api, mic_frames=[_silence(20)], speaker=speaker)
    conv = Conversation(name="live", turns=[], live=True)

    task = asyncio.create_task(rt.run(conv))
    await asyncio.sleep(0.05)
    rt.request_stop()
    await asyncio.wait_for(task, timeout=3.0)

    assert speaker.entered is True
    assert speaker.exited is True
    # All agent frames were rendered to the speaker, in order.
    assert speaker.played == agent_pcm


@pytest.mark.asyncio
async def test_play_agent_audio_false_uses_null_speaker(tmp_path: Path):
    """With playback disabled, no speaker factory is invoked (record-only) —
    the run still completes and records the agent."""
    rtc = _build_fake_lk_rtc(
        staged_events=[_stage_agent_join(), _stage_agent_track([_silence(20)])]
    )
    api = _build_fake_lk_api()
    speaker = _FakeSpeaker()
    rt = LiveKitLiveRuntime(
        url="wss://fake",
        api_key="ak",
        api_secret="sk",
        room="room-1",
        play_agent_audio=False,
        mixdown_dir=tmp_path / "mix",
        _lk_rtc=rtc,
        _lk_api=api,
        _mic_factory=_fake_mic_factory([_silence(20)]),
        _speaker_factory=_fake_speaker_factory(speaker),
    )
    rt.bind(replay_id="rep-live-2", conversation_hash="a" * 64)
    conv = Conversation(name="live", turns=[], live=True)

    task = asyncio.create_task(rt.run(conv))
    await asyncio.sleep(0.05)
    rt.request_stop()
    result = await asyncio.wait_for(task, timeout=3.0)

    # NullSpeaker is used — the injected fake speaker is never touched.
    assert speaker.played == []
    assert speaker.entered is False
    assert result.full_audio_path is not None


@pytest.mark.asyncio
async def test_request_stop_ends_open_ended_session(tmp_path: Path):
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    # Mic that never yields frames — the session only ends via request_stop.
    rt = _runtime(tmp_path, rtc, api, mic_frames=[])
    conv = Conversation(name="live", turns=[], live=True)

    task = asyncio.create_task(rt.run(conv))
    await asyncio.sleep(0.05)
    assert not task.done()  # still running, awaiting stop
    rt.request_stop()
    result = await asyncio.wait_for(task, timeout=3.0)
    assert result.responses == []


def test_agent_not_joined_raises(tmp_path: Path):
    rtc = _build_fake_lk_rtc(staged_events=[])  # agent never joins
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api, mic_frames=[_silence(20)])
    rt.agent_join_timeout_s = 0.05
    conv = Conversation(name="live", turns=[], live=True)

    with pytest.raises(AgentNotJoinedError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "agent_not_joined"
    assert exc.value.room == "room-1"


@pytest.mark.asyncio
async def test_agent_audio_timeout_independent_of_join_timeout(tmp_path: Path):
    """``agent_join_timeout_s`` gates the participant-join wait; the
    distinct ``agent_audio_timeout_s`` gates the audio-publish wait. An
    operator must be able to tune them independently — same field for both
    would surprise anyone shortening the join timeout for a fast-fail.

    The discriminator: a 0 s audio timeout against a 30 s join timeout, with
    the agent publishing its track only *after* the pump should have given
    up. If the audio wait were (wrongly) governed by ``agent_join_timeout_s``
    the pump would still be listening 50 ms in and would record + play the
    late track. Asserting the late track is NOT played is what proves the
    audio wait used the short, independent knob — a regression to the join
    timeout flips the assertion."""
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])  # joins, no track yet
    api = _build_fake_lk_api()
    speaker = _FakeSpeaker()
    rt = _runtime(tmp_path, rtc, api, mic_frames=[_silence(20)], speaker=speaker)
    rt.agent_join_timeout_s = 30.0  # generous join timeout
    rt.agent_audio_timeout_s = 0.0  # audio wait gives up on the first tick
    conv = Conversation(name="live", turns=[], live=True)

    task = asyncio.create_task(rt.run(conv))
    # The 0 s audio timeout fires and the agent pump returns before this
    # returns; 50 ms is far longer than the single loop tick it needs.
    await asyncio.sleep(0.05)
    # Agent publishes audio only NOW, after the pump already gave up. A pump
    # still bound to the 30 s join timeout would catch this and record it.
    track_event, track_args = _stage_agent_track([_silence(20), _silence(20)])
    rtc.Room.rooms[0].fire(track_event, *track_args)
    await asyncio.sleep(0.05)

    rt.request_stop()
    result = await asyncio.wait_for(task, timeout=3.0)
    # User-only recording finalized cleanly; no AgentNotJoinedError.
    assert result.full_audio_path is not None
    # The late agent track was ignored — the audio wait used the 0 s knob,
    # not the 30 s join timeout.
    assert speaker.played == []


@pytest.mark.asyncio
async def test_mic_factory_failure_propagates_and_disconnects(tmp_path: Path):
    """If the mic backend can't open (e.g. [live] extra missing), the error
    propagates and the room is still disconnected — and the already-running
    agent pump is cancelled, not orphaned."""
    from xray.errors import LiveDependencyError

    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()

    def _boom_factory(*, sample_rate: int, frame_samples: int) -> Any:
        raise LiveDependencyError("sounddevice not installed")

    rt = LiveKitLiveRuntime(
        url="wss://fake",
        api_key="ak",
        api_secret="sk",
        room="room-1",
        mixdown_dir=tmp_path / "mix",
        _lk_rtc=rtc,
        _lk_api=api,
        _mic_factory=_boom_factory,
        # Speaker opens fine; the MIC backend is what fails here — the
        # already-running agent pump must still be torn down (not orphaned).
        _speaker_factory=_fake_speaker_factory(_FakeSpeaker()),
    )
    rt.bind(replay_id="rep-live-x", conversation_hash="a" * 64)
    conv = Conversation(name="live", turns=[], live=True)

    with pytest.raises(LiveDependencyError):
        await rt.run(conv)
    assert rtc.Room.rooms[0].disconnect.await_count == 1


def test_write_live_mixdown_wall_clock_aligned(tmp_path: Path):
    # User speaks at t0 for 200ms; agent replies 0.5s in for 500ms.
    # Total span = max(0.0+0.2, 0.5+0.5) = 1.0s = SAMPLE_RATE frames.
    user = [(10.0, _silence(200))]
    agent = [(10.5, _silence(500))]
    out = tmp_path / "live.wav"
    write_live_mixdown(user_frames=user, agent_frames=agent, out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getnframes() == SAMPLE_RATE


def test_write_live_mixdown_bursts_laid_sequentially(tmp_path: Path):
    # Three frames sharing one arrival timestamp = a decode burst. The old
    # arrival-offset placement collapsed them onto the same samples (20ms of
    # garbled overlap); sequential placement lays them back-to-back (60ms).
    agent = [(0.0, _silence(20)), (0.0, _silence(20)), (0.0, _silence(20))]
    out = tmp_path / "burst.wav"
    write_live_mixdown(user_frames=[], agent_frames=agent, out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnframes() == SAMPLE_RATE * 60 // 1000


def test_write_live_mixdown_empty(tmp_path: Path):
    out = tmp_path / "empty.wav"
    write_live_mixdown(user_frames=[], agent_frames=[], out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getnframes() == 0


def test_write_live_mixdown_gap_preserved(tmp_path: Path):
    # Two agent frames 1s apart on the right channel; the gap must NOT be
    # compressed away (this is why live uses per-frame placement, not concat).
    agent = [(0.0, _silence(20)), (1.0, _silence(20))]
    out = tmp_path / "gap.wav"
    write_live_mixdown(user_frames=[], agent_frames=agent, out_path=out)
    with wave.open(str(out), "rb") as w:
        # Spans 0.0 → 1.02s ≈ SAMPLE_RATE + 20ms of frames.
        assert w.getnframes() == SAMPLE_RATE + SAMPLE_RATE * 20 // 1000
        assert w.getsampwidth() == SAMPLE_WIDTH_BYTES
        assert w.getnchannels() == NUM_CHANNELS + 1  # stereo
