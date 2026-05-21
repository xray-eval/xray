"""Typed errors for the xray SDK.

Every error carries a ``failure_reason`` that is a member of the server's
``REPLAY_FAILURE_REASONS`` picklist (see ``src/server/store/types.ts``).
A TS contract test at
``src/server/replays/replays.failure-reason-contract.test.ts`` asserts
this subset relationship — drifting either side breaks CI.

Callers narrow via ``isinstance`` and read the typed structured fields —
no message parsing, ever.
"""

from __future__ import annotations

from typing import ClassVar, Final, Literal

# Subset of the server's REPLAY_FAILURE_REASONS used by the SDK. Three
# distinct failure classes the driver can surface:
#   * `driver_aborted` — generic SDK-side failure (runtime binding errors,
#     mixdown errors, missing LiveKit extra, version mismatch, unmapped
#     exception)
#   * `agent_not_joined` — LiveKit agent participant never joined in time
#   * `audio_missing` — driver couldn't materialize a turn's audio bytes
#     (recorded file missing, TTS without OPENAI_API_KEY)
#
# Bunqueue DLQ reasons (`stalled`/`timeout`/`worker_lost`/...) and
# `upload_failed` are server-internal and never written by the SDK.
FailureReason = Literal[
    "driver_aborted",
    "agent_not_joined",
    "audio_missing",
]

# Runtime-side mirror of the picklist for membership checks. Frozen so a
# downstream mutation can't poison the orchestrator's classifier.
FAILURE_REASONS: Final[frozenset[FailureReason]] = frozenset(
    {"driver_aborted", "agent_not_joined", "audio_missing"}
)


class XrayError(Exception):
    """Base class for every error raised by the SDK."""

    # ClassVar so subclasses overwrite at class level, not per-instance.
    failure_reason: ClassVar[FailureReason] = "driver_aborted"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        # Stable name across minified / repackaged distributions — see
        # `.claude/rules/errors.md` §2.
        self.name: str = type(self).__name__


class RuntimeBindError(XrayError):
    """A runtime was asked to ``run`` before ``bind(replay_id=...)``."""

    failure_reason: ClassVar[FailureReason] = "driver_aborted"


class AgentNotJoinedError(XrayError):
    """The agent participant never joined the LiveKit room in time."""

    failure_reason: ClassVar[FailureReason] = "agent_not_joined"

    room: str
    timeout_s: float

    def __init__(self, room: str, timeout_s: float) -> None:
        super().__init__(f"agent participant did not join room {room!r} within {timeout_s}s")
        self.room = room
        self.timeout_s = timeout_s


class AudioMissingError(XrayError):
    """A user turn requires audio but none is available.

    Raised when an :class:`xray.conversation.RecordedAudio` points at a
    missing file, or when a :class:`xray.conversation.TtsAudio` is used
    without ``OPENAI_API_KEY`` configured.
    """

    failure_reason: ClassVar[FailureReason] = "audio_missing"

    turn_idx: int | None

    def __init__(self, message: str, *, turn_idx: int | None = None) -> None:
        super().__init__(message)
        self.turn_idx = turn_idx


class AudioTooLargeError(XrayError):
    """Mixdown WAV exceeds the server's per-upload cap."""

    failure_reason: ClassVar[FailureReason] = "driver_aborted"

    byte_size: int
    max_bytes: int

    def __init__(self, *, byte_size: int, max_bytes: int) -> None:
        super().__init__(f"replay mixdown is {byte_size} bytes; server cap is {max_bytes} bytes")
        self.byte_size = byte_size
        self.max_bytes = max_bytes


class MixdownError(XrayError):
    """Encoding the per-turn PCM streams into a single WAV failed."""

    failure_reason: ClassVar[FailureReason] = "driver_aborted"


class LiveKitDependencyError(XrayError):
    """The optional ``[livekit]`` extra is not installed."""

    failure_reason: ClassVar[FailureReason] = "driver_aborted"


class VersionFingerprintMismatchError(XrayError):
    """``POST /v1/conversations`` returned 409 — the dev edited the spec but
    forgot to bump ``Conversation.id`` (or pinned an explicit ``version``
    that collided)."""

    failure_reason: ClassVar[FailureReason] = "driver_aborted"

    def __init__(self, conversation_id: str, version: str) -> None:
        super().__init__(
            f'Conversation "{conversation_id}" version "{version}" already exists '
            "with a different turn structure"
        )
        self.conversation_id = conversation_id
        self.version = version


__all__ = [
    "FAILURE_REASONS",
    "AgentNotJoinedError",
    "AudioMissingError",
    "AudioTooLargeError",
    "FailureReason",
    "LiveKitDependencyError",
    "MixdownError",
    "RuntimeBindError",
    "VersionFingerprintMismatchError",
    "XrayError",
]
