"""LiveKit live runtime — drive a real, unscripted mic session.

Where :class:`xray.runtime.livekit.LiveKitRuntime` plays pre-authored
user turns into the room, this runtime streams the operating-system
microphone instead: the dev talks to their agent in real time. It joins
the room as the user-side participant (same JWT-attribute handshake, so
the agent's ``xray.attach`` binds the replay), publishes captured mic
frames as a live audio track, captures the agent's audio, and tees both
into one wall-clock-aligned stereo WAV (L = user mic, R = agent).

There is no script and no per-turn structure on the driver side. Turn
boundaries are derived server-side by VAD over the uploaded mixdown — the
same path the scripted runtime relies on — so this runtime emits no
``xray.turn`` spans of its own.

The session runs until :meth:`request_stop` is called (wired to SIGINT by
:func:`xray.run_live`). Both the mic backend and every LiveKit object
reach us through Protocols, so tests inject fakes with no real devices or
network. Branches over the ``Role`` literal would live here too, but a
live run carries no per-turn role dispatch.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from typing_extensions import override

from xray.conversation import Conversation
from xray.errors import AgentNotJoinedError, MixdownError, RuntimeBindError
from xray.runtime._audio_capture import (
    MicStream,
    MicStreamFactory,
    NullSpeaker,
    SpeakerSink,
    SpeakerSinkFactory,
    default_mic_factory,
    default_speaker_factory,
)
from xray.runtime._livekit_types import (
    LkApiModule,
    LkAudioSource,
    LkParticipant,
    LkRtcModule,
    LkTrack,
)
from xray.runtime.base import Runtime, RuntimeResult
from xray.runtime.livekit import (
    NUM_CHANNELS,
    SAMPLE_RATE,
    SAMPLE_WIDTH_BYTES,
    SAMPLES_PER_FRAME,
    load_livekit_modules,
    mint_user_token,
    write_live_mixdown,
)
from xray.runtime.sip import SimulatedSipCall

logger = logging.getLogger(__name__)

# A captured PCM frame tagged with the wall-clock second it arrived.
TimedFrame = tuple[float, bytes]


@dataclass
class LiveKitLiveRuntime(Runtime):
    """Joins a LiveKit room as the user-side participant and streams the OS
    microphone to the dev's agent in real time, recording both sides into a
    single stereo WAV the orchestrator uploads to xray.

    Stop the session with :meth:`request_stop` — :func:`xray.run_live` binds
    that to SIGINT so Ctrl+C ends the run cleanly."""

    url: str
    api_key: str = field(repr=False)
    api_secret: str = field(repr=False)
    room: str
    identity: str = "xray-driver"
    agent_join_timeout_s: float = 30.0
    # Separate from agent_join_timeout_s so an operator can tune "did the
    # agent participant ever join" and "did the agent publish audio after
    # joining" independently. Reuses agent_join_timeout_s as default so
    # existing call sites keep their effective behavior.
    agent_audio_timeout_s: float | None = None
    # Play the agent's audio to the OS speaker so the user can converse in
    # real time. Set False for a record-only session (headless/CI, or when no
    # output device is available). Headphones recommended — an open speaker
    # feeds back into the mic, both into the recording and back to the agent.
    play_agent_audio: bool = True
    cache_root: Path = field(default_factory=lambda: Path.home() / ".cache" / "xray-py")
    mixdown_dir: Path | None = None
    # When set, the live driver joins as ``ParticipantKind.SIP`` carrying
    # the configured ``sip.*`` attributes — useful for exploratory dialing
    # against the agent's real SIP code path without a real phone call.
    simulated_sip: SimulatedSipCall | None = None

    # Injection points for tests. None ⇒ load the real packages / devices.
    _lk_rtc: LkRtcModule | None = None
    _lk_api: LkApiModule | None = None
    _mic_factory: MicStreamFactory | None = None
    _speaker_factory: SpeakerSinkFactory | None = None

    # Populated by the orchestrator before ``run`` is called.
    replay_id: str | None = None
    conversation_hash: str | None = None

    # Set lazily inside ``run`` (needs a running loop); ``request_stop`` flips
    # it from the SIGINT handler.
    _stop_event: asyncio.Event | None = field(default=None, init=False, repr=False)

    def bind(self, *, replay_id: str, conversation_hash: str) -> None:
        """Called by the orchestrator once it knows the Replay's id."""
        self.replay_id = replay_id
        self.conversation_hash = conversation_hash

    def request_stop(self) -> None:
        """Signal the live session to wind down (disconnect, finalize the
        mixdown). Safe to call from a signal handler. No-op before ``run``
        has started."""
        if self._stop_event is not None:
            self._stop_event.set()

    def _mint_token(self, lk_api: LkApiModule) -> str:
        """JWT for the user-side driver, carrying the ``xray`` replay-context
        attribute (and ``sip.*`` + ``kind=sip`` when ``simulated_sip`` is set).
        A seam mirroring :meth:`LiveKitRuntime._mint_token` so the
        ``simulated_sip`` wiring is unit-testable without driving ``run``."""
        if self.replay_id is None or self.conversation_hash is None:
            raise RuntimeBindError(
                "LiveKitLiveRuntime: bind(replay_id=..., conversation_hash=...) "
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

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        if self.replay_id is None or self.conversation_hash is None:
            raise RuntimeBindError(
                "LiveKitLiveRuntime: bind(replay_id=..., conversation_hash=...) "
                "must be called before run()."
            )
        stop_event = asyncio.Event()
        self._stop_event = stop_event

        lk_rtc, lk_api = load_livekit_modules(self._lk_rtc, self._lk_api)
        token = self._mint_token(lk_api)

        room = lk_rtc.Room()
        agent_joined = asyncio.Event()
        agent_track_event = asyncio.Event()
        agent_track_holder: list[LkTrack] = []

        def _on_join(participant: LkParticipant) -> None:
            if participant.identity != self.identity:
                agent_joined.set()

        def _on_track(track: LkTrack, _publication: object, participant: LkParticipant) -> None:
            if participant.identity == self.identity:
                return
            kind = getattr(track, "kind", None)
            if kind == lk_rtc.TrackKind.KIND_AUDIO or str(kind).lower().endswith("audio"):
                agent_track_holder.append(track)
                agent_track_event.set()

        room.on("participant_connected")(_on_join)
        room.on("track_subscribed")(_on_track)

        user_frames: list[TimedFrame] = []
        agent_frames: list[TimedFrame] = []

        await room.connect(self.url, token, options=lk_rtc.RoomOptions())
        mic_task: asyncio.Task[None] | None = None
        agent_task: asyncio.Task[None] | None = None
        try:
            # Open the speaker and start consuming the agent's audio FIRST —
            # before the mic setup. The agent emits its greeting the instant it
            # joins; if we subscribe to its track late (after publishing our mic
            # etc.) the opening of that greeting is clipped, because LiveKit's
            # AudioStream only delivers frames from the moment of subscription.
            # Starting the agent pump now means we attach the instant the track
            # appears. (SpeakerSink.__aenter__ may raise SpeakerPlaybackError
            # before any task exists; NullSpeaker keeps the flow uniform when
            # playback is disabled.)
            speaker_cm: SpeakerSink = (
                self._speaker_factory_or_default()(sample_rate=SAMPLE_RATE, channels=NUM_CHANNELS)
                if self.play_agent_audio
                else NullSpeaker()
            )
            async with speaker_cm as speaker:
                agent_task = asyncio.create_task(
                    self._pump_agent(
                        lk_rtc, agent_track_holder, agent_track_event, agent_frames, speaker
                    )
                )

                # Confirm the agent actually joined (clear error if not). The
                # agent pump above is already waiting to attach its track.
                try:
                    await asyncio.wait_for(agent_joined.wait(), timeout=self.agent_join_timeout_s)
                except TimeoutError as e:
                    raise AgentNotJoinedError(self.room, self.agent_join_timeout_s) from e

                # Publish the mic + start capturing. The mic factory can raise
                # (e.g. LiveDependencyError when the [live] extra is missing);
                # agent_task is already running, so the finally below owns its
                # teardown.
                audio_source = lk_rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
                local_track = lk_rtc.LocalAudioTrack.create_audio_track("xray-user", audio_source)
                publish_opts = lk_rtc.TrackPublishOptions()
                publish_opts.source = lk_rtc.TrackSource.SOURCE_MICROPHONE
                await room.local_participant.publish_track(local_track, publish_opts)

                mic_stream = self._mic_factory_or_default()(
                    sample_rate=SAMPLE_RATE, frame_samples=SAMPLES_PER_FRAME
                )
                async with mic_stream:
                    mic_task = asyncio.create_task(
                        self._pump_mic(mic_stream, audio_source, lk_rtc, user_frames)
                    )
                    await stop_event.wait()
                # Exiting the `async with` closed the mic stream, which ends the
                # mic iterator and lets `mic_task` finish on its own.
                await mic_task
                # Stop the agent pump BEFORE the speaker closes so no
                # play()-after-close race (playback is best-effort regardless).
                agent_task.cancel()
                await asyncio.gather(agent_task, return_exceptions=True)
        finally:
            # Cancel + drain both pumps regardless of how we got here (normal
            # stop, agent-never-joined, mic-backend error). gather(... ,
            # return_exceptions=True) swallows CancelledError and any teardown
            # error so it can't mask the primary exception.
            pending = [t for t in (mic_task, agent_task) if t is not None and not t.done()]
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            await room.disconnect()

        logger.info(
            "live session captured %d user (mic) frames, %d agent frames",
            len(user_frames),
            len(agent_frames),
        )
        mixdown_path, recording_t0 = self._write_mixdown(user_frames, agent_frames)
        return RuntimeResult(
            responses=[],
            full_audio_path=str(mixdown_path) if mixdown_path is not None else None,
            recording_started_at_epoch=recording_t0,
            full_transcript=None,
        )

    def _mic_factory_or_default(self) -> MicStreamFactory:
        return default_mic_factory if self._mic_factory is None else self._mic_factory

    def _speaker_factory_or_default(self) -> SpeakerSinkFactory:
        return default_speaker_factory if self._speaker_factory is None else self._speaker_factory

    async def _pump_mic(
        self,
        mic_stream: MicStream,
        audio_source: LkAudioSource,
        lk_rtc: LkRtcModule,
        user_frames: list[TimedFrame],
    ) -> None:
        async for frame in mic_stream:
            user_frames.append((time.time(), frame))
            await self._publish_frame(audio_source, lk_rtc, frame)

    async def _publish_frame(
        self, audio_source: LkAudioSource, lk_rtc: LkRtcModule, pcm: bytes
    ) -> None:
        # LiveKit's AudioFrame wants exactly `samples_per_channel` samples;
        # the mic backend's fixed blocksize delivers that, but guard the
        # final short frame on close anyway.
        bytes_per_frame = SAMPLES_PER_FRAME * SAMPLE_WIDTH_BYTES * NUM_CHANNELS
        if len(pcm) < bytes_per_frame:
            pcm = pcm + b"\x00" * (bytes_per_frame - len(pcm))
        elif len(pcm) > bytes_per_frame:
            pcm = pcm[:bytes_per_frame]
        frame = lk_rtc.AudioFrame(
            data=pcm,
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            samples_per_channel=SAMPLES_PER_FRAME,
        )
        await audio_source.capture_frame(frame)

    async def _pump_agent(
        self,
        lk_rtc: LkRtcModule,
        agent_track_holder: list[LkTrack],
        agent_track_event: asyncio.Event,
        agent_frames: list[TimedFrame],
        speaker: SpeakerSink,
    ) -> None:
        if not agent_track_holder:
            audio_timeout = (
                self.agent_audio_timeout_s
                if self.agent_audio_timeout_s is not None
                else self.agent_join_timeout_s
            )
            try:
                await asyncio.wait_for(agent_track_event.wait(), timeout=audio_timeout)
            except TimeoutError:
                # Agent joined but never published audio. A user-only
                # recording is still a valid live session — don't fail it.
                return
        track = agent_track_holder[-1]
        stream = lk_rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)
        try:
            async for event in stream:
                frame = bytes(event.frame.data)
                agent_frames.append((time.time(), frame))
                # Playback is best-effort: a speaker glitch (or a close race
                # on shutdown) must never abort the recording.
                try:
                    await speaker.play(frame)
                except Exception:
                    logger.exception("agent audio playback failed; continuing recording")
        finally:
            await stream.aclose()

    def _write_mixdown(
        self, user_frames: list[TimedFrame], agent_frames: list[TimedFrame]
    ) -> tuple[Path | None, float | None]:
        if not user_frames and not agent_frames:
            return None, None
        mixdown_root = self.mixdown_dir or (self.cache_root / "replays")
        mixdown_root.mkdir(parents=True, exist_ok=True)
        out_path = mixdown_root / f"{self.replay_id}.wav"
        try:
            recording_t0 = write_live_mixdown(
                user_frames=user_frames, agent_frames=agent_frames, out_path=out_path
            )
        except OSError as e:
            raise MixdownError(f"could not write live mixdown WAV: {e}") from e
        return out_path, recording_t0

    @override
    async def aclose(self) -> None:
        return None


__all__ = [
    "LiveKitLiveRuntime",
    "TimedFrame",
]
