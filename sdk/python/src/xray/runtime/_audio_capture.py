"""OS-microphone capture for live sessions.

A live run sources its user-side audio from the operating-system
microphone instead of a scripted WAV. The capture backend is
``sounddevice`` (PortAudio), pulled in by the optional ``[live]`` extra.

The backend is loaded lazily (``importlib``) so neither the SDK import
nor CI needs ``sounddevice`` installed — only an actual
:func:`xray.run_live` call touches it. Tests inject a fake
:class:`MicStream` directly, mirroring the ``_lk_rtc`` / ``_openai_tts``
injection points on the scripted runtime.

Per ``sdk/python/.claude/rules/no-any.md`` the slice of ``sounddevice``
we touch is described by a Protocol — no ``Any`` for the foreign module.
"""

from __future__ import annotations

import asyncio
import importlib
from collections.abc import AsyncIterator, Callable
from typing import Protocol, runtime_checkable

from typing_extensions import Buffer

from xray.errors import LiveDependencyError, MicCaptureError, SpeakerPlaybackError

# ─── sounddevice surface (Protocol-typed) ─────────────────────────────


class _RawInputStream(Protocol):
    """The slice of ``sounddevice.RawInputStream`` instances we drive."""

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def close(self) -> None: ...


class _RawOutputStream(Protocol):
    """The slice of ``sounddevice.RawOutputStream`` instances we drive.
    Opened without a callback (blocking mode) so ``write`` accepts
    arbitrary-length agent frames; the return value is ignored."""

    def start(self) -> None: ...
    def stop(self) -> None: ...
    def close(self) -> None: ...
    def write(self, data: Buffer) -> object: ...


# The PortAudio callback receives a buffer of interleaved samples plus
# frame count, a timing struct, and a status flag set. We only read the
# buffer; ``time``/``status`` are opaque here.
SoundDeviceCallback = Callable[[Buffer, int, object, object], None]


@runtime_checkable
class SoundDeviceModule(Protocol):
    """The slice of the ``sounddevice`` module the capture backend uses."""

    def RawInputStream(
        self,
        *,
        samplerate: int,
        blocksize: int,
        channels: int,
        dtype: str,
        callback: SoundDeviceCallback,
    ) -> _RawInputStream: ...

    def RawOutputStream(
        self,
        *,
        samplerate: int,
        channels: int,
        dtype: str,
    ) -> _RawOutputStream: ...


# ─── Runtime-facing contract ──────────────────────────────────────────


class MicStream(Protocol):
    """An async-iterable of raw int16 mono PCM frames from the mic.

    Used as an async context manager: entering opens the device, the async
    iteration yields ~frame-sized chunks until the stream is closed, and
    exiting stops + releases the device. The live runtime stops iterating
    when its own SIGINT stop-event fires; closing the stream then ends the
    iterator.
    """

    async def __aenter__(self) -> MicStream: ...
    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None: ...
    def __aiter__(self) -> AsyncIterator[bytes]: ...


class MicStreamFactory(Protocol):
    """Builds a :class:`MicStream` for a given capture format. The live
    runtime calls this once per run; tests pass a fake that yields a fixed
    sequence of frames."""

    def __call__(self, *, sample_rate: int, frame_samples: int) -> MicStream: ...


class SpeakerSink(Protocol):
    """Plays agent audio to the OS speaker in real time so the user can
    actually converse. Used as an async context manager: entering opens the
    output device, :meth:`play` renders one int16 mono PCM frame, exiting
    releases the device. Playback is best-effort — the live runtime swallows
    ``play`` errors so a glitchy speaker never aborts the recording."""

    async def __aenter__(self) -> SpeakerSink: ...
    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None: ...
    async def play(self, frame: bytes) -> None: ...


class SpeakerSinkFactory(Protocol):
    """Builds a :class:`SpeakerSink` for a given output format."""

    def __call__(self, *, sample_rate: int, channels: int) -> SpeakerSink: ...


# ─── sounddevice-backed implementation ────────────────────────────────


def load_sounddevice() -> SoundDeviceModule:
    """Import ``sounddevice`` lazily. Raises :class:`LiveDependencyError`
    if the ``[live]`` extra isn't installed or the module is missing the
    surface we need."""
    try:
        mod: object = importlib.import_module("sounddevice")
    except ImportError as e:
        raise LiveDependencyError(
            "LiveKitLiveRuntime requires `pip install xray-py[live]` (sounddevice)."
        ) from e
    if not isinstance(mod, SoundDeviceModule):
        raise LiveDependencyError(
            "sounddevice is missing RawInputStream — installed version may be incompatible."
        )
    return mod


class SoundDeviceMicStream:
    """A :class:`MicStream` backed by a ``sounddevice.RawInputStream``.

    PortAudio invokes the capture callback on its own (non-asyncio) thread.
    The callback hands each frame to the event loop via
    ``loop.call_soon_threadsafe`` onto an :class:`asyncio.Queue`, which the
    async iterator drains. A ``None`` sentinel pushed on exit ends the
    iterator cleanly.
    """

    def __init__(
        self,
        *,
        sample_rate: int,
        frame_samples: int,
        sd: SoundDeviceModule,
    ) -> None:
        self._sample_rate = sample_rate
        self._frame_samples = frame_samples
        self._sd = sd
        self._stream: _RawInputStream | None = None
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def __aenter__(self) -> MicStream:
        self._loop = asyncio.get_running_loop()

        def _callback(indata: Buffer, _frames: int, _time: object, _status: object) -> None:
            # Copy out of the PortAudio-owned buffer immediately — it's
            # reused on the next callback. Hop to the event loop thread to
            # touch the asyncio.Queue safely.
            data = bytes(indata)
            loop = self._loop
            if loop is not None:
                loop.call_soon_threadsafe(self._queue.put_nowait, data)

        try:
            stream = self._sd.RawInputStream(
                samplerate=self._sample_rate,
                blocksize=self._frame_samples,
                channels=1,
                dtype="int16",
                callback=_callback,
            )
            stream.start()
        except Exception as e:
            raise MicCaptureError(f"could not open microphone: {e}") from e
        self._stream = stream
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        stream = self._stream
        self._stream = None
        try:
            if stream is not None:
                # close() MUST run even when stop() raises — otherwise the
                # PortAudio device handle leaks and the next session opens
                # with "device busy" (very confusing failure mode).
                try:
                    stream.stop()
                finally:
                    stream.close()
        except Exception as e:
            raise MicCaptureError(f"could not close microphone: {e}") from e
        finally:
            # Schedule the sentinel via call_soon_threadsafe so it lands
            # AFTER any in-flight callbacks the PortAudio thread scheduled
            # via call_soon_threadsafe before stop() returned. A direct
            # put_nowait(None) would enqueue ahead of them and the iterator
            # would return before draining the final frame.
            loop = self._loop
            if loop is not None and not loop.is_closed():
                loop.call_soon_threadsafe(self._queue.put_nowait, None)
            else:
                self._queue.put_nowait(None)

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[bytes]:
        while True:
            frame = await self._queue.get()
            if frame is None:
                return
            yield frame


def default_mic_factory(*, sample_rate: int, frame_samples: int) -> MicStream:
    """Default :class:`MicStreamFactory` — opens the real OS microphone."""
    sd = load_sounddevice()
    return SoundDeviceMicStream(sample_rate=sample_rate, frame_samples=frame_samples, sd=sd)


class SoundDeviceSpeakerSink:
    """A :class:`SpeakerSink` backed by a blocking ``sounddevice``
    ``RawOutputStream``. Each :meth:`play` writes one frame on a worker
    thread (``asyncio.to_thread``) so the write's natural backpressure
    paces playback without blocking the event loop."""

    def __init__(self, *, sample_rate: int, channels: int, sd: SoundDeviceModule) -> None:
        self._sample_rate = sample_rate
        self._channels = channels
        self._sd = sd
        self._stream: _RawOutputStream | None = None

    async def __aenter__(self) -> SpeakerSink:
        try:
            stream = self._sd.RawOutputStream(
                samplerate=self._sample_rate,
                channels=self._channels,
                dtype="int16",
            )
            stream.start()
        except Exception as e:
            raise SpeakerPlaybackError(
                f"could not open speaker (pass play_agent_audio=False to record only): {e}"
            ) from e
        self._stream = stream
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        stream = self._stream
        self._stream = None
        if stream is not None:
            try:
                # Same close-must-run shape as the mic stream above — a raise
                # from stop() must not strand the output device handle.
                try:
                    stream.stop()
                finally:
                    stream.close()
            except Exception as e:
                raise SpeakerPlaybackError(f"could not close speaker: {e}") from e

    async def play(self, frame: bytes) -> None:
        stream = self._stream
        if stream is None:
            return
        await asyncio.to_thread(stream.write, frame)


class NullSpeaker:
    """A :class:`SpeakerSink` that discards audio — used when
    ``play_agent_audio=False`` (record-only, e.g. headless/CI)."""

    async def __aenter__(self) -> SpeakerSink:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        return None

    async def play(self, frame: bytes) -> None:
        return None


def default_speaker_factory(*, sample_rate: int, channels: int) -> SpeakerSink:
    """Default :class:`SpeakerSinkFactory` — opens the real OS speaker."""
    sd = load_sounddevice()
    return SoundDeviceSpeakerSink(sample_rate=sample_rate, channels=channels, sd=sd)


__all__ = [
    "MicStream",
    "MicStreamFactory",
    "NullSpeaker",
    "SoundDeviceMicStream",
    "SoundDeviceModule",
    "SoundDeviceSpeakerSink",
    "SpeakerSink",
    "SpeakerSinkFactory",
    "default_mic_factory",
    "default_speaker_factory",
    "load_sounddevice",
]
