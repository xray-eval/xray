"""Tests for the real ``SoundDeviceMicStream`` against a fake sounddevice
module — exercises the PortAudio-callback → asyncio.Queue → async-iterator
path without a real microphone."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from xray.errors import LiveDependencyError, MicCaptureError, SpeakerPlaybackError
from xray.runtime._audio_capture import (
    SoundDeviceMicStream,
    SoundDeviceSpeakerSink,
    load_sounddevice,
)


class _FakeRawInputStream:
    def __init__(self, *, callback: Any, raise_on_start: bool = False, **_: Any) -> None:
        self._callback = callback
        self._raise_on_start = raise_on_start
        self.started = False
        self.stopped = False
        self.closed = False

    def start(self) -> None:
        if self._raise_on_start:
            raise RuntimeError("device busy")
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def close(self) -> None:
        self.closed = True

    def feed(self, data: bytes) -> None:
        # Mimic PortAudio invoking the capture callback on its thread.
        self._callback(data, len(data) // 2, None, None)


class _FakeRawOutputStream:
    def __init__(self, *, raise_on_start: bool = False) -> None:
        self._raise_on_start = raise_on_start
        self.started = False
        self.stopped = False
        self.closed = False
        self.written: list[bytes] = []

    def start(self) -> None:
        if self._raise_on_start:
            raise RuntimeError("no output device")
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def close(self) -> None:
        self.closed = True

    def write(self, data: Any) -> object:
        self.written.append(bytes(data))
        return None


class _FakeSoundDevice:
    def __init__(self, *, raise_on_start: bool = False) -> None:
        self.raise_on_start = raise_on_start
        self.streams: list[_FakeRawInputStream] = []
        self.out_streams: list[_FakeRawOutputStream] = []

    def RawInputStream(
        self,
        *,
        samplerate: int,
        blocksize: int,
        channels: int,
        dtype: str,
        callback: Any,
    ) -> _FakeRawInputStream:
        stream = _FakeRawInputStream(callback=callback, raise_on_start=self.raise_on_start)
        self.streams.append(stream)
        return stream

    def RawOutputStream(
        self,
        *,
        samplerate: int,
        channels: int,
        dtype: str,
    ) -> _FakeRawOutputStream:
        stream = _FakeRawOutputStream(raise_on_start=self.raise_on_start)
        self.out_streams.append(stream)
        return stream


@pytest.mark.asyncio
async def test_mic_stream_delivers_callback_frames_to_iterator():
    sd = _FakeSoundDevice()
    stream = SoundDeviceMicStream(sample_rate=48000, frame_samples=960, sd=sd)

    received: list[bytes] = []
    async with stream:
        raw = sd.streams[0]
        assert raw.started is True
        raw.feed(b"\x01\x02" * 960)
        raw.feed(b"\x03\x04" * 960)

        async def _collect() -> None:
            async for frame in stream:
                received.append(frame)

        task = asyncio.create_task(_collect())
        # Let the queued frames drain to the iterator.
        await asyncio.sleep(0.01)

    # Exiting the context stops the device and pushes the sentinel; the
    # iterator then terminates.
    await asyncio.wait_for(task, timeout=1.0)
    assert raw.stopped is True
    assert raw.closed is True
    assert received == [b"\x01\x02" * 960, b"\x03\x04" * 960]


@pytest.mark.asyncio
async def test_mic_stream_raises_mic_capture_error_when_device_fails():
    sd = _FakeSoundDevice(raise_on_start=True)
    stream = SoundDeviceMicStream(sample_rate=48000, frame_samples=960, sd=sd)
    with pytest.raises(MicCaptureError):
        await stream.__aenter__()


@pytest.mark.asyncio
async def test_speaker_sink_writes_frames_to_output_device():
    sd = _FakeSoundDevice()
    sink = SoundDeviceSpeakerSink(sample_rate=48000, channels=1, sd=sd)
    async with sink:
        out = sd.out_streams[0]
        assert out.started is True
        await sink.play(b"\x01\x02" * 480)
        await sink.play(b"\x03\x04" * 480)
    assert out.written == [b"\x01\x02" * 480, b"\x03\x04" * 480]
    assert out.stopped is True
    assert out.closed is True


@pytest.mark.asyncio
async def test_speaker_sink_raises_when_device_fails():
    sd = _FakeSoundDevice(raise_on_start=True)
    sink = SoundDeviceSpeakerSink(sample_rate=48000, channels=1, sd=sd)
    with pytest.raises(SpeakerPlaybackError):
        await sink.__aenter__()


def test_load_sounddevice_missing_raises_live_dependency_error(monkeypatch: pytest.MonkeyPatch):
    import importlib

    def _raise(_name: str) -> object:
        raise ImportError("No module named 'sounddevice'")

    monkeypatch.setattr(importlib, "import_module", _raise)
    with pytest.raises(LiveDependencyError):
        load_sounddevice()
