"""Structural typing for the slice of LiveKit's API the runtime touches.

LiveKit is an optional extra. To avoid importing it at module scope,
the runtime calls ``_load_livekit()`` lazily; tests inject fakes via
the runtime's ``_lk_rtc`` / ``_lk_api`` fields.

These Protocols describe everything we actually need from the lk_rtc
and lk_api modules. The real livekit package satisfies them
structurally; so do the fakes in ``tests/test_livekit_runtime.py``.
Per ``sdk/python/.claude/rules/no-any.md`` we don't use ``Any`` for
foreign types — we Protocol-type them.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal, Protocol, runtime_checkable

# LiveKit's ParticipantKind picklist (livekit-api access_token.py). Mirrored
# here so the Protocol's ``with_kind`` stays type-checked without importing
# from the optional ``livekit`` package at module scope.
LkParticipantKind = Literal["standard", "egress", "ingress", "sip", "agent"]

# ─── Runtime objects (instances) ──────────────────────────────────────


class LkAudioFrame(Protocol):
    """A single ~20 ms PCM frame in/out of an audio source/stream."""

    data: bytes
    sample_rate: int
    num_channels: int
    samples_per_channel: int


class LkAudioSource(Protocol):
    """Writes outbound audio frames into the LiveKit pipeline."""

    async def capture_frame(self, frame: LkAudioFrame) -> None: ...


class LkAudioStreamEvent(Protocol):
    """One yield from ``AudioStream.__aiter__``."""

    @property
    def frame(self) -> LkAudioFrame: ...


class LkAudioStream(Protocol):
    """Async-iterable of agent-side audio frames."""

    def __aiter__(self) -> AsyncIterator[LkAudioStreamEvent]: ...
    async def aclose(self) -> None: ...


class LkTrack(Protocol):
    """A published media track. We only inspect ``kind``."""

    kind: object  # protobuf enum at runtime; compared structurally


class LkLocalParticipant(Protocol):
    async def publish_track(self, track: LkTrack, options: LkTrackPublishOptions) -> object: ...


class LkTrackPublishOptions(Protocol):
    source: object  # set to lk_rtc.TrackSource.SOURCE_MICROPHONE


class LkParticipant(Protocol):
    """Both local and remote participants expose ``identity``."""

    identity: str


class LkRoom(Protocol):
    local_participant: LkLocalParticipant

    def on(self, event: str) -> Callable[[Callable[..., object]], Callable[..., object]]:
        """Register an event listener. LiveKit's API is decorator-style
        when called with one argument."""
        ...

    async def connect(self, url: str, token: str, *, options: LkRoomOptions) -> None: ...
    async def disconnect(self) -> None: ...


class LkRoomOptions(Protocol):
    """Opaque options bag; we pass an empty instance."""


class LkTranscriptionSegment(Protocol):
    text: str
    final: bool


# ─── Module surface — constructors + enum values ──────────────────────


class _LkLocalAudioTrack(Protocol):
    @staticmethod
    def create_audio_track(name: str, source: LkAudioSource) -> LkTrack: ...


class _LkTrackSource(Protocol):
    SOURCE_MICROPHONE: object


class _LkTrackKind(Protocol):
    KIND_AUDIO: object


@runtime_checkable
class LkRtcModule(Protocol):
    """The slice of ``livekit.rtc`` the runtime uses."""

    AudioSource: Callable[[int, int], LkAudioSource]
    AudioFrame: Callable[..., LkAudioFrame]  # kwargs-only at call sites
    AudioStream: Callable[..., LkAudioStream]  # kwargs after positional track
    LocalAudioTrack: type[_LkLocalAudioTrack]
    Room: Callable[[], LkRoom]
    RoomOptions: Callable[[], LkRoomOptions]
    TrackPublishOptions: Callable[[], LkTrackPublishOptions]
    TrackKind: _LkTrackKind
    TrackSource: _LkTrackSource


# ─── livekit.api ──────────────────────────────────────────────────────


class LkAccessToken(Protocol):
    def with_identity(self, identity: str) -> LkAccessToken: ...
    def with_grants(self, grants: LkVideoGrants) -> LkAccessToken: ...
    def with_attributes(self, attributes: dict[str, str]) -> LkAccessToken: ...
    def with_kind(self, kind: LkParticipantKind) -> LkAccessToken: ...
    def to_jwt(self) -> str: ...


class LkVideoGrants(Protocol):
    """Opaque grant bag — constructed with ``room_join`` + ``room`` kwargs."""


@runtime_checkable
class LkApiModule(Protocol):
    AccessToken: Callable[[str, str], LkAccessToken]
    VideoGrants: Callable[..., LkVideoGrants]


class OpenAiTtsFn(Protocol):
    """Test-injected TTS hook called as ``await fn(text=, voice=, model=)``.

    Returns ``bytes`` of raw 24 kHz int16 PCM. Modeled as a Protocol so
    fakes match by shape (matching ``no-any.md`` — no ``Callable[..., Any]``).
    """

    def __call__(self, *, text: str, voice: str, model: str) -> Awaitable[bytes]: ...


__all__ = [
    "LkAccessToken",
    "LkApiModule",
    "LkAudioFrame",
    "LkAudioSource",
    "LkAudioStream",
    "LkAudioStreamEvent",
    "LkLocalParticipant",
    "LkParticipant",
    "LkParticipantKind",
    "LkRoom",
    "LkRoomOptions",
    "LkRtcModule",
    "LkTrack",
    "LkTrackPublishOptions",
    "LkTranscriptionSegment",
    "LkVideoGrants",
    "OpenAiTtsFn",
]
