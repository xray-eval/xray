"""Runtime ABC.

A runtime joins the dev's transport (LiveKit room, Pipecat session, …),
plays the user-side audio for each user turn, captures the agent's
transcript and audio per turn, then returns a structured result the
orchestrator stitches into a Replay.

A runtime *may* additionally implement :class:`RuntimeBindable` so the
orchestrator can hand it the freshly-minted ``replay_id`` BEFORE
``run`` is invoked. The base class doesn't require this — Pipecat and
WebSocket runtimes that don't need replay-id propagation can omit it.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from xray.conversation import AgentResponse, Conversation


@dataclass
class RuntimeResult:
    """What the runtime captured during one execution of a Conversation."""

    # Per-turn outcomes, indexed by the same order as ``Conversation.turns``.
    # User turns have a synthesized ``AgentResponse`` with empty fields so the
    # caller can iterate uniformly.
    responses: list[AgentResponse] = field(default_factory=list[AgentResponse])
    # Path under the runtime's working dir to the full-replay audio mixdown
    # (if produced). The orchestrator uploads it to xray.
    full_audio_path: str | None = None
    full_transcript: str | None = None
    # Wall-clock (Unix epoch seconds) of audio sample 0 in the mixdown — the
    # earliest turn ``started_at``. The orchestrator sends it as the
    # ``X-Recording-Started-At`` header so the server can map span timestamps
    # onto the audio timeline (see spec 0001). None when no audio was produced.
    recording_started_at_epoch: float | None = None


class Runtime(ABC):
    """Pluggable runtime contract.

    Subclasses MUST be safe to construct *before* the orchestrator knows the
    Replay id — the id is plumbed in via :meth:`RuntimeBindable.bind` when
    the run starts.
    """

    @abstractmethod
    async def run(self, conversation: Conversation) -> RuntimeResult:
        """Execute one Replay of ``conversation`` and return what was
        observed."""

    @abstractmethod
    async def aclose(self) -> None:
        """Release any sockets / processes the runtime opened. The
        orchestrator calls this in a ``finally`` so partial runs clean up."""


@runtime_checkable
class RuntimeBindable(Protocol):
    """Optional mixin contract: the orchestrator calls ``bind`` after it
    has created the Replay row, so the runtime can stamp the id onto
    transport metadata (LiveKit room metadata, OTEL baggage, …) before
    ``run`` is invoked.

    Structural — no inheritance required. ``isinstance(rt,
    RuntimeBindable)`` works because of ``@runtime_checkable``.
    """

    def bind(
        self,
        *,
        replay_id: str,
        conversation_hash: str,
    ) -> None: ...


@runtime_checkable
class UserAudioInjectable(Protocol):
    """Optional contract for runtimes that play scripted user-turn audio.
    The orchestrator prefetches every user turn's 48 kHz mono PCM from
    the server (``GET /v1/conversations/:hash/turns/:idx/audio``) and
    hands the map (turn idx → PCM bytes) to the runtime before ``run``.
    Runtimes without scripted user audio (live mic) simply don't
    implement it.

    Structural — ``isinstance(rt, UserAudioInjectable)`` works because of
    ``@runtime_checkable``.
    """

    def inject_user_audio(self, audio: Mapping[int, bytes]) -> None: ...


@runtime_checkable
class StoppableRuntime(Protocol):
    """Optional contract for runtimes that run open-endedly until told to
    stop — e.g. a live mic session that ends on Ctrl+C. ``xray.run_live``
    binds :meth:`request_stop` to SIGINT so the run winds down cleanly
    (disconnect, finalize the mixdown, upload).

    Structural — ``isinstance(rt, StoppableRuntime)`` works because of
    ``@runtime_checkable``.
    """

    def request_stop(self) -> None: ...


__all__ = [
    "Runtime",
    "RuntimeBindable",
    "RuntimeResult",
    "StoppableRuntime",
    "UserAudioInjectable",
]
