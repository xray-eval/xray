"""Unit tests for ``LiveKitRuntime`` with the LiveKit room I/O stubbed.

We never hit the network: ``lk_rtc`` / ``lk_api`` are stub modules
injected via the runtime's ``_lk_rtc`` / ``_lk_api`` fields. The fake
Room fires staged events from inside its ``connect`` coroutine so the
runtime's ``wait_for(agent_joined.wait())`` resolves immediately.
"""

from __future__ import annotations

import array
import asyncio
import time
import wave
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from xray import Conversation, SimulatedSipCall, Turn
from xray.errors import AgentNotJoinedError, AudioMissingError, RuntimeBindError
from xray.runtime.livekit import (
    _UTTERANCE_GAP_S,
    SAMPLE_RATE,
    SAMPLE_WIDTH_BYTES,
    LiveKitRuntime,
    _BargeInTrigger,
    _ContinuousAgentCapture,
    _place_frames,
    _TurnSegment,
    write_stereo_mixdown,
)


class _FakeRoom:
    def __init__(
        self,
        staged_events: list[tuple[str, tuple[Any, ...]]],
        remote_participants: dict[str, Any] | None = None,
    ) -> None:
        self._handlers: dict[str, list[Any]] = {}
        self._staged_events = staged_events
        self.remote_participants: dict[str, Any] = dict(remote_participants or {})
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
    events that the room fires inside ``connect`` and the participants
    already present in the room at connect time."""

    staged_events: list[tuple[str, tuple[Any, ...]]] = field(
        default_factory=list[tuple[str, tuple[Any, ...]]]
    )
    remote_participants: dict[str, Any] = field(default_factory=dict[str, Any])
    rooms: list[_FakeRoom] = field(default_factory=list[_FakeRoom])

    def __call__(self) -> _FakeRoom:
        room = _FakeRoom(
            staged_events=self.staged_events,
            remote_participants=self.remote_participants,
        )
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
    """Async-iterable yielding one event per frame attached to the track via
    ``_xray_frames``. Drained by the runtime's continuous agent pump (which
    subscribes at connect), so the frames land in the recording regardless of
    which turn is playing."""

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


class _ScriptedAgentStream:
    """Queue-driven agent ``AudioStream``: yields frames fed via ``feed()``,
    blocking when empty until ``end()`` (mirrors the live suite's mic stream).
    Lets a test deliver agent audio at a controlled moment — e.g. after the
    last turn, to exercise the never-stop teardown."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.aclose = AsyncMock(return_value=None)

    def feed(self, frame: bytes) -> None:
        self._queue.put_nowait(frame)

    def end(self) -> None:
        self._queue.put_nowait(None)

    def __aiter__(self) -> AsyncIterator[Any]:
        async def _gen() -> AsyncIterator[Any]:
            while True:
                frame = await self._queue.get()
                if frame is None:
                    return
                event = MagicMock()
                event.frame = MagicMock()
                event.frame.data = frame
                yield event

        return _gen()


def _build_fake_lk_rtc(
    staged_events: list[tuple[str, tuple[Any, ...]]] | None = None,
    remote_participants: dict[str, Any] | None = None,
) -> Any:
    rtc = MagicMock(name="lk_rtc")
    rtc.Room = _FakeRoomFactory(
        staged_events=staged_events or [],
        remote_participants=remote_participants or {},
    )
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
    return _stage_transcription(text, seg_id=f"seg-{text}", final=True)


def _stage_transcription(text: str, *, seg_id: str, final: bool) -> tuple[str, tuple[Any, ...]]:
    agent = MagicMock()
    agent.identity = "agent-bot"
    seg = MagicMock()
    seg.id = seg_id
    seg.text = text
    seg.final = final
    return ("transcription_received", ([seg], agent, MagicMock()))


def _make_silence_pcm(ms: int) -> bytes:
    sample_count = SAMPLE_RATE * ms // 1000
    return b"\x00\x00" * sample_count


def _make_tone_pcm(ms: int) -> bytes:
    """A constant loud int16 PCM buffer — distinguishable from silence in the
    mixdown so a test can assert a channel actually carries audio."""
    sample_count = SAMPLE_RATE * ms // 1000
    return b"\xff\x7f" * sample_count  # 0x7FFF, full-scale


def _final_segment(text: str) -> Any:
    seg = MagicMock()
    seg.id = f"seg-{text}"
    seg.text = text
    seg.final = True
    return seg


def _runtime(
    tmp_path: Path,
    lk_rtc: Any,
    lk_api: Any,
    user_audio: dict[int, bytes] | None = None,
) -> LiveKitRuntime:
    rt = LiveKitRuntime(
        url="wss://fake",
        api_key="ak",
        api_secret="sk",
        room="room-1",
        cache_root=tmp_path / "cache",
        mixdown_dir=tmp_path / "mix",
        # Tear down as soon as the turns finish — the never-stop teardown has
        # its own dedicated test; other tests don't want its wait.
        agent_quiet_period_s=0.0,
        _lk_rtc=lk_rtc,
        _lk_api=lk_api,
    )
    rt.bind(replay_id="rep-1", conversation_hash="a" * 64)
    rt.inject_user_audio(user_audio if user_audio is not None else {0: _make_silence_pcm(40)})
    return rt


def _fire_agent_transcripts(
    rt: LiveKitRuntime,
    rtc: Any,
    events_by_idx: dict[int, list[tuple[str, tuple[Any, ...]]]],
) -> None:
    """Fire each agent turn's staged transcription events just after that turn
    starts waiting for its final. With continuous capture the agent's audio no
    longer paces its transcript, so tests drive the transcript from the turn
    itself (call_soon lands the events after ``_capture_agent_turn`` has run its
    stale-queue drain and is awaiting ``final_seen``)."""
    original = rt._capture_agent_turn

    async def _wrapped(*, idx: int, **kw: Any) -> Any:
        loop = asyncio.get_running_loop()
        for name, args in events_by_idx.get(idx, []):
            loop.call_soon(rtc.Room.rooms[0].fire, name, *args)
        return await original(idx=idx, **kw)

    rt._capture_agent_turn = _wrapped


def test_bind_required_before_run():
    rt = LiveKitRuntime(url="x", api_key="k", api_secret="s", room="r")
    conv = Conversation(name="c", turns=[Turn.user("hi")])
    with pytest.raises(RuntimeBindError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "driver_aborted"


def test_runtime_threads_simulated_sip_into_minted_token():
    """A LiveKitRuntime built with ``simulated_sip`` mints its JWT with
    ``kind=sip`` and the sip.* attributes — proving the field actually reaches
    ``mint_user_token`` rather than being silently dropped in the wiring."""
    token = MagicMock(name="AccessToken")
    token.with_identity.return_value = token
    token.with_grants.return_value = token
    token.with_kind.return_value = token
    token.with_attributes.return_value = token
    token.to_jwt.return_value = "fake-jwt"
    api = MagicMock(name="lk_api")
    api.AccessToken = MagicMock(return_value=token)
    api.VideoGrants = MagicMock()

    rt = LiveKitRuntime(
        url="wss://fake",
        api_key="ak",
        api_secret="sk",
        room="room-1",
        simulated_sip=SimulatedSipCall(caller_phone="+15551234567"),
    )
    rt.bind(replay_id="rep-1", conversation_hash="a" * 64)
    jwt = rt._mint_token(api)

    assert jwt == "fake-jwt"
    token.with_kind.assert_called_once_with("sip")
    attrs = token.with_attributes.call_args.args[0]
    assert attrs["sip.phoneNumber"] == "+15551234567"


def test_missing_injected_audio_raises_audio_missing(tmp_path: Path):
    """A user turn whose idx has no injected PCM is a wiring bug — the
    runtime fails fast with the turn pinned instead of publishing
    silence."""
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api, user_audio={})

    conv = Conversation(name="c", turns=[Turn.user("hi", key="u0")])

    with pytest.raises(AudioMissingError) as exc:
        asyncio.run(rt.run(conv))
    assert exc.value.failure_reason == "audio_missing"
    assert exc.value.turn_idx == 0


def test_write_stereo_mixdown_round_trips(tmp_path: Path):
    out = tmp_path / "out.wav"
    write_stereo_mixdown(user_frames=[(0.0, _make_silence_pcm(40))], agent_frames=[], out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getframerate() == SAMPLE_RATE
        assert w.getsampwidth() == SAMPLE_WIDTH_BYTES


def test_write_stereo_mixdown_wall_clock_aligned(tmp_path: Path):
    """Frames placed at their arrival offsets from t0, silence padding
    between. User at t0 for 200ms; agent 0.5s in for 500ms; span = 1.0s.
    Returns t0 — the recording anchor the orchestrator sends on upload."""
    user = [(10.0, _make_silence_pcm(200))]
    agent = [(10.5, _make_silence_pcm(500))]

    out = tmp_path / "wall_clock.wav"
    recording_t0 = write_stereo_mixdown(user_frames=user, agent_frames=agent, out_path=out)

    assert recording_t0 == 10.0
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        # t0 = 10.0, span = max(10.0+0.2, 10.5+0.5) - 10.0 = 1.0s = 48000 frames
        assert w.getnframes() == SAMPLE_RATE


def test_write_stereo_mixdown_bursts_laid_sequentially(tmp_path: Path):
    """Three agent frames sharing one arrival stamp = a decode burst. Raw
    arrival-offset placement would collapse them onto the same 20ms; sequential
    placement lays them back-to-back (60ms)."""
    burst = [(0.0, _make_silence_pcm(20))] * 3
    out = tmp_path / "burst.wav"
    write_stereo_mixdown(user_frames=[], agent_frames=burst, out_path=out)
    with wave.open(str(out), "rb") as w:
        assert w.getnframes() == SAMPLE_RATE * 60 // 1000


def test_write_stereo_mixdown_gap_preserved(tmp_path: Path):
    """A genuine arrival gap between two agent frames is NOT compressed away —
    per-frame placement keeps cross-channel who-spoke-when intact."""
    agent = [(0.0, _make_silence_pcm(20)), (1.0, _make_silence_pcm(20))]
    out = tmp_path / "gap.wav"
    write_stereo_mixdown(user_frames=[], agent_frames=agent, out_path=out)
    with wave.open(str(out), "rb") as w:
        # Spans 0.0 → 1.02s ≈ SAMPLE_RATE + 20ms of frames.
        assert w.getnframes() == SAMPLE_RATE + SAMPLE_RATE * 20 // 1000


def test_write_stereo_mixdown_overlap_carries_both_channels(tmp_path: Path):
    """When user and agent audio overlap in time (a barge-in), each channel
    carries its own PCM verbatim — genuinely stereo, not summed into one."""
    user = [(0.5, _make_tone_pcm(100))]
    agent = [(0.0, _make_tone_pcm(1000))]
    out = tmp_path / "overlap.wav"
    write_stereo_mixdown(user_frames=user, agent_frames=agent, out_path=out)
    with wave.open(str(out), "rb") as w:
        interleaved = array.array("h")
        interleaved.frombytes(w.readframes(w.getnframes()))
    left = interleaved[0::2]  # user channel
    right = interleaved[1::2]  # agent channel
    assert any(v != 0 for v in left), "user channel empty"
    assert any(v != 0 for v in right), "agent channel empty"


def test_write_stereo_mixdown_handles_empty_input(tmp_path: Path):
    """No frames: a valid empty stereo WAV (header only), and no anchor —
    there is no sample 0 to timestamp."""
    out = tmp_path / "empty.wav"
    recording_t0 = write_stereo_mixdown(user_frames=[], agent_frames=[], out_path=out)
    assert recording_t0 is None
    with wave.open(str(out), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getnframes() == 0


def test_runtime_publishes_injected_user_turn_and_produces_mixdown(tmp_path: Path):
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api, user_audio={0: _make_silence_pcm(40)})

    conv = Conversation(
        name="c",
        turns=[Turn.user("hi", key="u0")],
    )

    result = asyncio.run(rt.run(conv))

    room = rtc.Room.rooms[0]
    assert room.local_participant.publish_track.await_count == 1
    assert result.full_audio_path is not None
    # The recording anchor (wall-clock of mixdown sample 0) rides along so
    # the orchestrator can send X-Recording-Started-At on upload.
    assert result.recording_started_at_epoch is not None
    out_path = Path(result.full_audio_path)
    assert out_path.exists() and out_path.stat().st_size > 44  # WAV header is 44 B
    with wave.open(str(out_path), "rb") as w:
        assert w.getnchannels() == 2
        assert w.getframerate() == SAMPLE_RATE
        assert w.getnframes() == SAMPLE_RATE * 40 // 1000


def test_runtime_captures_agent_turn_via_transcription(tmp_path: Path):
    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            _stage_agent_track([_make_silence_pcm(20), _make_silence_pcm(20)]),
        ]
    )
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 2.0
    # The agent turn (idx 1) goes final once its transcript arrives — fired from
    # the turn, since the continuous pump no longer paces transcripts by audio.
    _fire_agent_transcripts(rt, rtc, {1: [_stage_transcription_final("confirmed at 7pm")]})

    conv = Conversation(
        name="c",
        turns=[
            Turn.user("hello", key="u0"),
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
        # Continuous capture records the agent's 40ms; the wall-clock-aligned
        # file spans at least that (plus the gap to the user turn).
        assert w.getnframes() >= SAMPLE_RATE * 40 // 1000


@pytest.mark.asyncio
async def test_continuous_capture_records_frames_regardless_of_turn():
    """The pump records every agent frame from track-appearance to teardown —
    the basis for capturing off-turn agent speech (during a user turn, or after
    a turn's transcript goes final) that the old per-turn capture never saw."""
    stream = _ScriptedAgentStream()
    rtc = _build_fake_lk_rtc()

    def _audio_stream(_track: Any, **_kw: Any) -> _ScriptedAgentStream:
        return stream

    rtc.AudioStream = _audio_stream
    track = MagicMock()
    track.kind = "audio"
    capture = _ContinuousAgentCapture(lk_rtc=rtc, track_holder=[track], track_event=asyncio.Event())
    capture.track_event.set()

    pump = asyncio.create_task(capture.pump())
    await asyncio.sleep(0)  # let the pump attach and block awaiting frames
    stream.feed(_make_tone_pcm(20))
    stream.feed(_make_tone_pcm(20))
    await asyncio.sleep(0)  # let it drain what was fed
    stream.end()
    await asyncio.wait_for(pump, timeout=2.0)

    assert len(capture.frames) == 2
    assert all(pcm == _make_tone_pcm(20) for _arrival, pcm in capture.frames)


async def _drive_interrupted_pair(
    rt: LiveKitRuntime,
    *,
    frames: list[bytes],
    final_after_frame: int,
    interrupt_after_ms: int,
    pre_pair_frames: list[bytes] | None = None,
) -> tuple[_TurnSegment, _TurnSegment | None]:
    """Drive ``_play_interrupted_pair`` directly, feeding agent frames into the
    continuous capture at a fixed arrival stamp (a synchronous burst — the
    condition write_stereo_mixdown warns about) so placement is content-timed
    and deterministic. A final transcription is pushed after ``final_after_frame``.
    ``pre_pair_frames`` are fed BEFORE the pair task starts — modelling agent
    speech the pump captured while an earlier turn was still running, the
    off-turn speech the pair's tap arrives too late to observe.
    Returns the agent segment and the user segment (None if it never fired)."""
    track = MagicMock()
    track.kind = "audio"
    lk_rtc = rt._lk_rtc
    assert lk_rtc is not None  # set by _runtime; narrows LkRtcModule | None
    capture = _ContinuousAgentCapture(
        lk_rtc=lk_rtc, track_holder=[track], track_event=asyncio.Event()
    )
    capture.track_event.set()
    queue: asyncio.Queue[Any] = asyncio.Queue()

    # A real (near-now) stamp, not a synthetic constant: the pair's head-start
    # computation treats a frameless wall-clock gap as the utterance having
    # ended, so pre-pair frames must look freshly arrived. One stamp for every
    # frame keeps the burst synchronous → placement stays content-timed.
    arrival = time.time()
    for frame in pre_pair_frames or []:
        capture.on_frame(arrival, frame)

    task = asyncio.create_task(
        rt._play_interrupted_pair(
            agent_idx=0,
            agent_turn=Turn.agent(key="a0"),
            user_idx=1,
            user_turn=Turn.user("no, Berlin", key="u1", interrupt_after_ms=interrupt_after_ms),
            audio_source=lk_rtc.AudioSource(SAMPLE_RATE, 1),
            lk_rtc=lk_rtc,
            capture=capture,
            transcription_queue=queue,
        )
    )
    await asyncio.sleep(0)  # let the pair install its tap and reach the final wait
    for i, frame in enumerate(frames):
        capture.on_frame(arrival, frame)
        await asyncio.sleep(0)
        if i == final_after_frame:
            queue.put_nowait(_final_segment("done"))
            await asyncio.sleep(0)
    agent_seg, _response, user_seg = await asyncio.wait_for(task, timeout=2.0)
    return agent_seg, user_seg


def test_barge_in_fires_when_agent_audio_reaches_the_threshold(tmp_path: Path):
    rt = _runtime(
        tmp_path, _build_fake_lk_rtc(), _build_fake_lk_api(), user_audio={1: _make_tone_pcm(80)}
    )
    rt.agent_turn_timeout_s = 2.0
    # 8 frames × 20ms; the agent stays final-free until frame 6, so the 60ms
    # barge-in point (frame 3) lands while it's still talking.
    agent_seg, user_seg = asyncio.run(
        _drive_interrupted_pair(
            rt, frames=[_make_tone_pcm(20)] * 8, final_after_frame=6, interrupt_after_ms=60
        )
    )
    assert user_seg is not None
    assert len(user_seg.pcm) > 0  # the user's audio was published
    assert user_seg.started_at is not None and agent_seg.started_at is not None
    assert user_seg.started_at >= agent_seg.started_at


def test_barge_in_is_placed_by_agent_content_not_wallclock(tmp_path: Path):
    """The barge-in is recorded at the agent-audio CONTENT offset it fired on,
    not wall-clock. Frames are fed at one constant arrival stamp — the bursting
    condition write_stereo_mixdown warns about — so wall-clock elapsed to receive
    them is ~0 while 100ms of agent content precedes the barge-in. A wall-clock
    stamp would put the user segment ~0ms after the agent onset (an inflated
    yield_ms); the content-derived stamp puts it 100ms in."""
    rt = _runtime(
        tmp_path, _build_fake_lk_rtc(), _build_fake_lk_api(), user_audio={1: _make_tone_pcm(80)}
    )
    rt.agent_turn_timeout_s = 2.0
    # 8 frames × 20ms; barge-in fires once 100ms of agent content is received.
    agent_seg, user_seg = asyncio.run(
        _drive_interrupted_pair(
            rt, frames=[_make_tone_pcm(20)] * 8, final_after_frame=6, interrupt_after_ms=100
        )
    )
    assert user_seg is not None
    assert agent_seg.started_at is not None and user_seg.started_at is not None
    # ~100ms for the content-derived stamp (float epoch precision loses a
    # sub-microsecond fraction); the old wall-clock stamp lands near 0.
    gap_ms = (user_seg.started_at - agent_seg.started_at) * 1000
    assert gap_ms >= 90, f"barge-in placed by wall-clock ({gap_ms:.1f}ms), not agent content"


def test_barge_in_degrades_when_the_agent_finishes_first(tmp_path: Path):
    rt = _runtime(
        tmp_path, _build_fake_lk_rtc(), _build_fake_lk_api(), user_audio={1: _make_tone_pcm(80)}
    )
    rt.agent_turn_timeout_s = 2.0
    # Only 60ms of agent audio total, but the barge-in point is 5s in — the
    # agent finishes long before it, so there's nothing to interrupt.
    _agent_seg, user_seg = asyncio.run(
        _drive_interrupted_pair(
            rt, frames=[_make_tone_pcm(20)] * 3, final_after_frame=0, interrupt_after_ms=5_000
        )
    )
    assert user_seg is None


def test_barge_in_counts_from_agent_speech_onset_not_capture_start(tmp_path: Path):
    """`interrupt_after_ms` is measured from the agent's speech onset, not from
    capture start. The captured stream leads with the agent's pre-speech silence
    (it "thinks" before talking); counting that silence would fire the barge-in
    early — before the agent speaks — collapsing the turn structure into a
    spec_vad_mismatch instead of a real overlap. Here 100ms of silence precedes
    160ms of speech, so a 60ms barge-in must land 160ms into the content (100ms
    silence + 60ms speech), not 60ms in."""
    rt = _runtime(
        tmp_path, _build_fake_lk_rtc(), _build_fake_lk_api(), user_audio={1: _make_tone_pcm(80)}
    )
    rt.agent_turn_timeout_s = 2.0
    frames = [_make_silence_pcm(20)] * 5 + [_make_tone_pcm(20)] * 8
    agent_seg, user_seg = asyncio.run(
        _drive_interrupted_pair(rt, frames=frames, final_after_frame=11, interrupt_after_ms=60)
    )
    assert user_seg is not None
    assert agent_seg.started_at is not None and user_seg.started_at is not None
    # 100ms silence + 60ms speech = 160ms of content before the barge-in.
    # Counting the silence would fire at 60ms (near the start, still silent).
    gap_ms = (user_seg.started_at - agent_seg.started_at) * 1000
    assert gap_ms >= 150, f"barge-in fired during pre-speech silence ({gap_ms:.1f}ms in)"


def test_barge_in_counts_agent_speech_that_began_before_the_pair(tmp_path: Path):
    """Full-duplex agents start replying while the previous user turn is still
    playing, so the pump captures agent speech before the barge-in pair is
    reached and its tap installed. That head start must count toward
    ``interrupt_after_ms`` — the delay is measured from the agent's first word,
    not its first word after the tap (docs/sdk-python.md: the barge-in lands at
    the same point "regardless of the agent's latency").

    100ms of agent speech precedes the pair; a 60ms barge-in is therefore
    already overdue and fires on the first tapped frame, landing 120ms into the
    agent's speech (100ms pre-tap + the 20ms frame that trips it), measured from
    the true onset. Without the fix it fires 60ms in (pre-tap speech uncounted);
    a seed-only fix lands at 20ms and a backdate-only fix at 160ms — the window
    below rejects all three."""
    rt = _runtime(
        tmp_path, _build_fake_lk_rtc(), _build_fake_lk_api(), user_audio={1: _make_tone_pcm(80)}
    )
    rt.agent_turn_timeout_s = 2.0
    agent_seg, user_seg = asyncio.run(
        _drive_interrupted_pair(
            rt,
            frames=[_make_tone_pcm(20)] * 8,
            final_after_frame=6,
            interrupt_after_ms=60,
            pre_pair_frames=[_make_tone_pcm(20)] * 5,
        )
    )
    assert user_seg is not None
    assert agent_seg.started_at is not None and user_seg.started_at is not None
    gap_ms = (user_seg.started_at - agent_seg.started_at) * 1000
    assert 110 <= gap_ms <= 130, f"expected ~120ms from the agent's onset, got {gap_ms:.1f}ms"


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

    track_event = _stage_agent_track([_make_silence_pcm(20)])
    # Agent turn 0 goes final on "first"; agent turn 2 gets nothing, so it must
    # time out empty rather than inherit the stale segment.
    first_final = _stage_transcription_final("first")
    # The stale segment fires during user playback (between agent turns 0 and 2).
    # Without the queue-drain on entry, agent turn 2 ends on it instantly.
    stale = _stage_transcription_final("stale")

    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            track_event,
        ]
    )

    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api, user_audio={1: _make_silence_pcm(40)})
    rt.agent_turn_timeout_s = 0.3
    _fire_agent_transcripts(rt, rtc, {0: [first_final]})

    # Wrap _play_user_turn to fire the stale event AFTER the user turn plays —
    # between agent turns 0 and 2 — matching the real-world window when Gemini
    # Live's delayed `conversation_item_added` fires.
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
            Turn.user("hi", key="u0"),
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


def _run_agent_turn_with_caption_events(
    tmp_path: Path, events: list[tuple[str, tuple[Any, ...]]]
) -> str:
    """Drive one user + one agent turn; fire the given caption events during
    the agent turn (idx 1); return the agent transcript."""
    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            _stage_agent_track([_make_silence_pcm(20), _make_silence_pcm(20)]),
        ]
    )
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 2.0
    _fire_agent_transcripts(rt, rtc, {1: events})

    conv = Conversation(name="c", turns=[Turn.user("hello", key="u0"), Turn.agent(key="a0")])
    result = asyncio.run(rt.run(conv))
    return result.responses[1].transcript


def test_cumulative_caption_segments_are_replaced_not_appended(tmp_path: Path):
    """TTS-aligned caption streams (e.g. Gradium via LiveKit's
    ``use_tts_aligned_transcript``) re-send one segment id with cumulatively
    growing text, and the final full-utterance segment can arrive under a
    NEW id. Appending every event repeats the whole prefix per partial
    (``Hallo! Hallo! Ich Hallo! Ich bin …``) — the driver must keep only
    the latest text per segment id and merge overlapping texts."""
    transcript = _run_agent_turn_with_caption_events(
        tmp_path,
        [
            _stage_transcription("Hallo!", seg_id="s1", final=False),
            _stage_transcription("Hallo! Ich bin der Assistent.", seg_id="s1", final=False),
            _stage_transcription(
                "Hallo! Ich bin der Assistent. Wie kann ich helfen?", seg_id="s2", final=True
            ),
        ],
    )
    assert transcript == "Hallo! Ich bin der Assistent. Wie kann ich helfen?"


def test_distinct_caption_segments_join_in_arrival_order(tmp_path: Path):
    """Two segments carrying different sentences (the non-cumulative case)
    still join with a space, in first-arrival order."""
    transcript = _run_agent_turn_with_caption_events(
        tmp_path,
        [
            _stage_transcription("Erste Antwort.", seg_id="a", final=False),
            _stage_transcription("Zweite Antwort.", seg_id="b", final=True),
        ],
    )
    assert transcript == "Erste Antwort. Zweite Antwort."


def test_flush_control_token_is_stripped_from_transcript(tmp_path: Path):
    """Gradium terminates utterances with a literal ``<flush>`` control tag;
    it must never leak into stored transcripts (spans, UI, judge input)."""
    transcript = _run_agent_turn_with_caption_events(
        tmp_path,
        [
            _stage_transcription("Guten Tag. <flush>", seg_id="s1", final=True),
        ],
    )
    assert transcript == "Guten Tag."


def test_agent_already_in_room_at_connect_is_detected(tmp_path: Path):
    """The agent job is dispatched on room creation, so the agent can join
    BEFORE the driver connects. ``participant_connected`` never fires for a
    participant that is already in the room — the runtime must scan
    ``room.remote_participants`` after connect or the replay dies with
    ``AgentNotJoinedError`` while both parties sit in the room."""
    agent = MagicMock()
    agent.identity = "agent-bot"
    rtc = _build_fake_lk_rtc(staged_events=[], remote_participants={"agent-bot": agent})
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_join_timeout_s = 0.05

    conv = Conversation(name="c", turns=[Turn.user("hi", key="u0")])

    result = asyncio.run(rt.run(conv))
    assert result.full_audio_path is not None


def test_pre_joined_driver_identity_does_not_count_as_agent(tmp_path: Path):
    """A stale remote participant carrying the driver's own identity (e.g. a
    zombie session from a crashed prior run) must not satisfy the join wait
    — the scan goes through the same identity filter as the event handler."""
    ghost = MagicMock()
    ghost.identity = "xray-driver"
    rtc = _build_fake_lk_rtc(staged_events=[], remote_participants={"xray-driver": ghost})
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_join_timeout_s = 0.05

    conv = Conversation(name="c", turns=[Turn.user("hi")])

    with pytest.raises(AgentNotJoinedError):
        asyncio.run(rt.run(conv))


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

    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)

    conv = Conversation(
        name="c",
        turns=[Turn.user("hello there", key="u0")],
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
    """The driver emits one ``xray.turn`` span per turn — role=user for the
    played audio, role=agent for the captured response — with monotonically
    increasing idx values (these spans drive the inspector's turn timeline).
    Distinct idx values keep the server PK ``(replay_id, idx)`` from colliding
    with anything an agent worker might emit on its own.
    """
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    import xray.runtime.livekit as livekit_mod

    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(livekit_mod, "_TRACER", provider.get_tracer("xray-py-driver", "0.0.1"))

    rtc = _build_fake_lk_rtc(
        staged_events=[
            _stage_agent_join(),
            _stage_agent_track([_make_silence_pcm(20), _make_silence_pcm(20)]),
        ]
    )
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api)
    rt.agent_turn_timeout_s = 2.0
    # Fire the agent transcription during the agent turn (idx 1) — the
    # continuous pump no longer paces transcripts by audio frames.
    _fire_agent_transcripts(rt, rtc, {1: [_stage_transcription_final("confirmed at 7pm")]})

    conv = Conversation(
        name="c",
        turns=[
            Turn.user("hello", key="u0"),
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


def test_barge_in_turn_spans_are_trace_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Both turn spans on the barge-in path must be trace roots, matching every
    other turn. The user turn is published via ``asyncio.create_task`` from
    inside the agent's span scope, and create_task copies the active context —
    so without an explicit root reset the user span nests UNDER the agent span,
    shaping the barge-in trace differently from every normal turn."""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    import xray.runtime.livekit as livekit_mod

    provider = TracerProvider()
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(livekit_mod, "_TRACER", provider.get_tracer("xray-py-driver", "0.0.1"))

    rt = _runtime(
        tmp_path, _build_fake_lk_rtc(), _build_fake_lk_api(), user_audio={1: _make_tone_pcm(80)}
    )
    rt.agent_turn_timeout_s = 2.0
    asyncio.run(
        _drive_interrupted_pair(
            rt, frames=[_make_tone_pcm(20)] * 8, final_after_frame=6, interrupt_after_ms=60
        )
    )

    turn_spans = [s for s in exporter.get_finished_spans() if s.name == "xray.turn"]
    assert len(turn_spans) == 2, f"expected 2 xray.turn spans, got {len(turn_spans)}"
    by_role = {(s.attributes or {}).get("xray.turn.role"): s for s in turn_spans}
    assert set(by_role) == {"user", "agent"}
    for role, span in by_role.items():
        assert span.parent is None, f"{role} turn span nests under another span; expected a root"


def test_injected_audio_is_published_verbatim(tmp_path: Path):
    """The runtime publishes exactly the injected PCM — no resampling, no
    local synthesis, no filesystem reads. Frame count over the audio
    source must equal ceil(samples / SAMPLES_PER_FRAME)."""
    pcm = _make_silence_pcm(40)  # 40ms @ 48kHz = 1920 samples = 2 frames
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join()])
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api, user_audio={0: pcm})

    conv = Conversation(name="conv-x", turns=[Turn.user("hello world", key="u0")])
    result = asyncio.run(rt.run(conv))

    room = rtc.Room.rooms[0]
    track = room.local_participant.publish_track.await_args.args[0]
    published = b"".join(bytes(f.data) for f in track.source.captured)
    assert published == pcm
    assert result.full_audio_path is not None


def test_barge_in_trigger_ignores_silence():
    """Silence never crosses the speech onset, so no voiced time accrues and the
    trigger stays dormant — the agent's pre-speech 'thinking' must not fire it."""
    trigger = _BargeInTrigger(after_ms=40)
    assert trigger.observe(_make_silence_pcm(200)) is False


def test_barge_in_trigger_fires_once_at_threshold():
    trigger = _BargeInTrigger(after_ms=40)
    assert trigger.observe(_make_tone_pcm(20)) is False  # 20ms voiced
    assert trigger.observe(_make_tone_pcm(20)) is True  # 40ms → fires
    assert trigger.observe(_make_tone_pcm(20)) is False  # already fired, never twice


def test_barge_in_trigger_counts_from_speech_onset():
    """Leading silence doesn't spend the budget — voiced time accrues only after
    the first speech frame."""
    trigger = _BargeInTrigger(after_ms=40)
    assert trigger.observe(_make_silence_pcm(100)) is False  # silence: no accrual
    assert trigger.observe(_make_tone_pcm(20)) is False  # 20ms voiced
    assert trigger.observe(_make_tone_pcm(20)) is True  # 40ms voiced → fires


def test_barge_in_trigger_seed_credits_pre_tap_speech():
    """Speech the trigger never observed live — it began before the tap was
    installed — is credited via seed(), which latches the onset too, so the
    first frame observed after the tap can fire the barge-in."""
    trigger = _BargeInTrigger(after_ms=100)
    trigger.seed(80)
    assert trigger.observe(_make_tone_pcm(20)) is True  # 80 seeded + 20 = 100 → fires


def test_barge_in_trigger_seed_zero_credits_nothing():
    """A non-positive seed is a no-op — no phantom onset, no phantom budget — so
    the trigger still counts from a real speech onset."""
    trigger = _BargeInTrigger(after_ms=40)
    trigger.seed(0)
    assert trigger.observe(_make_silence_pcm(100)) is False  # seed latched no onset
    assert trigger.observe(_make_tone_pcm(20)) is False  # 20ms voiced
    assert trigger.observe(_make_tone_pcm(20)) is True  # 40ms voiced → fires


def test_capture_cursor_matches_place_frames():
    """The capture's incremental content cursor must land where _place_frames
    puts the end of the same frames — the invariant that makes a barge-in's
    content-anchored placement match the mixdown layout, across bursts and gaps."""
    frames = [
        (0.0, _make_tone_pcm(20)),  # onset
        (0.0, _make_tone_pcm(20)),  # burst (same arrival)
        (0.5, _make_tone_pcm(20)),  # genuine gap
    ]
    capture = _ContinuousAgentCapture(
        lk_rtc=MagicMock(), track_holder=[], track_event=asyncio.Event()
    )
    for arrival, pcm in frames:
        capture.on_frame(arrival, pcm)

    _placed, total_samples = _place_frames(frames, t0=0.0)
    assert capture.content_end_epoch is not None
    cursor_samples = round(capture.content_end_epoch * SAMPLE_RATE)
    # Float-epoch cursor vs _place_frames' per-frame int() truncation may differ
    # by <1 sample — negligible against 30ms VAD frames.
    assert abs(cursor_samples - total_samples) <= 1


def _capture() -> _ContinuousAgentCapture:
    return _ContinuousAgentCapture(lk_rtc=MagicMock(), track_holder=[], track_event=asyncio.Event())


def test_continuous_capture_tracks_current_utterance():
    """current_utterance_ms reconstructs the voiced-plus-intra-pause ms of the
    utterance in progress — the head start a barge-in pair credits when its tap
    arrives mid-utterance. It counts from speech onset (leading silence
    excluded) and treats a frameless wall-clock gap as the utterance ended."""
    capture = _capture()
    assert capture.current_utterance_ms(now=0.0) == 0  # nothing captured yet

    for _ in range(5):
        capture.on_frame(0.0, _make_silence_pcm(20))  # 100ms leading silence
    for _ in range(3):
        capture.on_frame(0.0, _make_tone_pcm(20))  # 60ms speech
    assert capture.current_utterance_ms(now=0.0) == 60  # onset-relative, silence excluded
    # A pair reached a full gap later in wall-clock (DTX track went frameless):
    # the utterance is treated as ended, so no stale credit leaks out.
    assert capture.current_utterance_ms(now=_UTTERANCE_GAP_S) == 0


def test_continuous_capture_utterance_ends_after_trailing_silence():
    """Speech then >= _UTTERANCE_GAP_S of trailing content-silence is a finished
    utterance: current_utterance_ms returns 0 so a later barge-in counts fresh
    from the next utterance, not the stale one (the early fire cac718c fixed)."""
    capture = _capture()
    for _ in range(3):
        capture.on_frame(0.0, _make_tone_pcm(20))  # 60ms speech
    for _ in range(50):
        capture.on_frame(0.0, _make_silence_pcm(20))  # 1000ms trailing comfort-noise
    assert capture.current_utterance_ms(now=0.0) == 0


def test_continuous_capture_new_utterance_resets_onset():
    """After a >= gap silence, fresh speech is a NEW utterance — onset moves to
    it, so only the latest utterance counts (a greeting before the real reply
    must not inflate the head start)."""
    capture = _capture()
    capture.on_frame(0.0, _make_tone_pcm(20))  # greeting: 20ms
    for _ in range(50):
        capture.on_frame(0.0, _make_silence_pcm(20))  # 1000ms gap
    capture.on_frame(0.0, _make_tone_pcm(20))  # real reply onset
    capture.on_frame(0.0, _make_tone_pcm(20))  # + 20ms
    assert capture.current_utterance_ms(now=0.0) == 40  # only the real reply counts


@pytest.mark.asyncio
async def test_agent_speech_after_last_turn_is_recorded(tmp_path: Path):
    """Never-stop teardown: after the last scripted turn, xray keeps recording
    until the agent goes quiet — a late 'double answer' that lands after the
    conversation was 'done' is still captured."""
    stream = _ScriptedAgentStream()
    rtc = _build_fake_lk_rtc(staged_events=[_stage_agent_join(), _stage_agent_track([])])

    def _audio_stream(_track: Any, **_kw: Any) -> _ScriptedAgentStream:
        return stream  # always the scripted feed, ignoring the track's own frames

    rtc.AudioStream = _audio_stream
    api = _build_fake_lk_api()
    rt = _runtime(tmp_path, rtc, api, user_audio={0: _make_silence_pcm(40)})
    rt.agent_quiet_period_s = 0.2  # short, but non-zero: wait for the tail
    rt.agent_turn_timeout_s = 2.0

    conv = Conversation(name="c", turns=[Turn.user("hi", key="u0")])
    task = asyncio.create_task(rt.run(conv))
    # Let the run play the user turn and reach the quiet-wait, then the agent
    # speaks late — after the conversation was "done".
    await asyncio.sleep(0.05)
    stream.feed(_make_tone_pcm(20))
    await asyncio.sleep(0.05)
    stream.end()
    result = await asyncio.wait_for(task, timeout=3.0)

    assert result.full_audio_path is not None
    with wave.open(result.full_audio_path, "rb") as w:
        interleaved = array.array("h")
        interleaved.frombytes(w.readframes(w.getnframes()))
    right = interleaved[1::2]  # agent channel
    assert any(v != 0 for v in right), "late agent reply was not recorded"
