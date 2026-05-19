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


class Runtime(ABC):
    """Pluggable runtime contract.

    Subclasses MUST be safe to construct *before* the orchestrator knows the
    Replay id — the id is plumbed in via :meth:`RuntimeBindable.bind` (or
    ``xray.trace.set_replay_context``) when the run starts.
    """

    @abstractmethod
    async def run(self, conversation: Conversation) -> RuntimeResult:
        """Execute one Replay of ``conversation`` and return what was
        observed. Must call ``xray.trace.set_replay_context(...)`` (or
        equivalent) before any span the agent emits."""

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
        conversation_id: str,
        conversation_version: str,
    ) -> None: ...


__all__ = [
    "Runtime",
    "RuntimeBindable",
    "RuntimeResult",
]
