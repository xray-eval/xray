"""Runtime ABC.

A runtime joins the dev's transport (LiveKit room, Pipecat session, …),
plays the user-side audio for each user turn, captures the agent's
transcript and audio per turn, then returns a structured result the
orchestrator stitches into a Replay.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from xray.conversation import AgentResponse, Conversation


@dataclass
class RuntimeResult:
    """What the runtime captured during one execution of a Conversation."""

    # Per-turn outcomes, indexed by the same order as ``Conversation.turns``.
    # User turns have a synthesized ``AgentResponse`` with empty fields so the
    # caller can iterate uniformly.
    responses: list[AgentResponse] = field(default_factory=list)
    # Path under the runtime's working dir to the full-replay audio mixdown
    # (if produced). The orchestrator uploads it to xray.
    full_audio_path: str | None = None
    full_transcript: str | None = None


class Runtime(ABC):
    """Pluggable runtime contract.

    Subclasses MUST be safe to construct *before* the orchestrator knows the
    Replay id — the id is plumbed in via ``set_replay_context`` when the
    run starts.
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
