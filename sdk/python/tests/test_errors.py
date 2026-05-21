from __future__ import annotations

from collections.abc import Callable

import pytest

from xray.errors import (
    AgentNotJoinedError,
    AudioMissingError,
    AudioTooLargeError,
    FailureReason,
    LiveKitDependencyError,
    MixdownError,
    RuntimeBindError,
    VersionFingerprintMismatchError,
    XrayError,
)


@pytest.mark.parametrize(
    "ctor,expected",
    [
        (lambda: RuntimeBindError("bind first"), "driver_aborted"),
        (lambda: AgentNotJoinedError("room-1", 5.0), "agent_not_joined"),
        (lambda: AudioMissingError("missing.wav", turn_idx=0), "audio_missing"),
        (lambda: AudioTooLargeError(byte_size=99, max_bytes=10), "driver_aborted"),
        (lambda: MixdownError("oops"), "driver_aborted"),
        (lambda: LiveKitDependencyError("install [livekit]"), "driver_aborted"),
        (lambda: VersionFingerprintMismatchError("conv-A", "v1"), "driver_aborted"),
    ],
)
def test_each_error_carries_its_failure_reason(
    ctor: Callable[[], XrayError], expected: FailureReason
) -> None:
    err = ctor()
    assert isinstance(err, XrayError)
    assert err.failure_reason == expected


def test_agent_not_joined_keeps_structured_fields():
    err = AgentNotJoinedError("booking-room", 12.5)
    assert err.room == "booking-room"
    assert err.timeout_s == 12.5


def test_audio_missing_keeps_turn_idx():
    err = AudioMissingError("path-not-found.wav", turn_idx=3)
    assert err.turn_idx == 3


def test_audio_too_large_keeps_sizes():
    err = AudioTooLargeError(byte_size=10_000, max_bytes=1000)
    assert err.byte_size == 10_000
    assert err.max_bytes == 1000


def test_version_fingerprint_mismatch_keeps_typed_attrs():
    err = VersionFingerprintMismatchError("conv-A", "v1")
    assert err.conversation_id == "conv-A"
    assert err.version == "v1"
    assert type(err).__name__ == "VersionFingerprintMismatchError"
