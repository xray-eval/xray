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

from typing import Final, Literal

# Subset of the server's REPLAY_FAILURE_REASONS used by the SDK. Six
# distinct failure classes the driver / orchestrator can surface:
#   * `driver_aborted` — generic SDK-side failure (runtime binding errors,
#     mixdown errors, missing LiveKit extra, version mismatch, unmapped
#     exception)
#   * `agent_not_joined` — LiveKit agent participant never joined in time
#   * `audio_missing` — driver couldn't materialize a turn's audio bytes
#     (recorded file missing, TTS without OPENAI_API_KEY)
#   * `transcription_failed` / `metrics_failed` / `evaluation_failed` —
#     the server's analyze-chain stage failed. The SDK never writes these;
#     it reads them from the server's `failed` SSE event and surfaces them
#     via :class:`ReplayEvaluationError`.
#
# Bunqueue DLQ reasons (`stalled`/`timeout`/`worker_lost`/...) and
# `upload_failed` are server-internal and never written by the SDK.
FailureReason = Literal[
    "driver_aborted",
    "agent_not_joined",
    "audio_missing",
    "transcription_failed",
    "metrics_failed",
    "evaluation_failed",
]

# Runtime-side mirror of the picklist for membership checks. Frozen so a
# downstream mutation can't poison the orchestrator's classifier.
FAILURE_REASONS: Final[frozenset[FailureReason]] = frozenset(
    {
        "driver_aborted",
        "agent_not_joined",
        "audio_missing",
        "transcription_failed",
        "metrics_failed",
        "evaluation_failed",
    }
)


class XrayError(Exception):
    """Base class for every error raised by the SDK."""

    # Plain attribute, not ClassVar: subclasses override at class level OR
    # assign per-instance in __init__ (see ReplayEvaluationError).
    failure_reason: FailureReason = "driver_aborted"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.name: str = type(self).__name__


class RuntimeBindError(XrayError):
    """A runtime was asked to ``run`` before ``bind(replay_id=...)``."""

    failure_reason: FailureReason = "driver_aborted"


class AgentNotJoinedError(XrayError):
    """The agent participant never joined the LiveKit room in time."""

    failure_reason: FailureReason = "agent_not_joined"

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

    failure_reason: FailureReason = "audio_missing"

    turn_idx: int | None

    def __init__(self, message: str, *, turn_idx: int | None = None) -> None:
        super().__init__(message)
        self.turn_idx = turn_idx


class AudioTooLargeError(XrayError):
    """Mixdown WAV exceeds the server's per-upload cap."""

    failure_reason: FailureReason = "driver_aborted"

    byte_size: int
    max_bytes: int

    def __init__(self, *, byte_size: int, max_bytes: int) -> None:
        super().__init__(f"replay mixdown is {byte_size} bytes; server cap is {max_bytes} bytes")
        self.byte_size = byte_size
        self.max_bytes = max_bytes


class MixdownError(XrayError):
    """Encoding the per-turn PCM streams into a single WAV failed."""

    failure_reason: FailureReason = "driver_aborted"


class LiveKitDependencyError(XrayError):
    """The optional ``[livekit]`` extra is not installed."""

    failure_reason: FailureReason = "driver_aborted"


class ReplayEvaluationError(XrayError):
    """The server failed the analyze chain before producing a verdict.

    Carries the stage-specific ``failure_reason`` so the dev can decide
    whether the test should be retried (transient transcription provider
    error) or investigated (consistent evaluation crash). Distinct from
    "the test ran and assertions failed" — that case returns a
    :class:`xray.ReplayResult` with ``passed=False``, no exception.
    """

    replay_id: str

    def __init__(self, replay_id: str, failure_reason: FailureReason) -> None:
        super().__init__(
            f"server failed replay {replay_id!r} during evaluation chain: {failure_reason}"
        )
        self.replay_id = replay_id
        self.failure_reason = failure_reason


class XrayServerError(XrayError):
    """The xray server returned an unexpected HTTP error.

    Wraps :class:`httpx.HTTPStatusError` so the dev sees a typed
    :class:`XrayError` instead of a raw ``httpx`` exception. The
    orchestrator raises this for HTTP failures that happen BEFORE the
    replay row exists — once it exists, failures flow through the typed
    ``failure_reason`` PATCH path instead.
    """

    failure_reason: FailureReason = "driver_aborted"

    status_code: int

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


__all__ = [
    "FAILURE_REASONS",
    "AgentNotJoinedError",
    "AudioMissingError",
    "AudioTooLargeError",
    "FailureReason",
    "LiveKitDependencyError",
    "MixdownError",
    "ReplayEvaluationError",
    "RuntimeBindError",
    "XrayError",
    "XrayServerError",
]
