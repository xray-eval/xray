"""Test-definition primitives.

A ``Conversation`` is the dev-authored spec: an ordered list of ``Turn``\\ s,
plus per-turn assertion predicates and a per-replay LLM judge. The SDK
auto-computes the ``version`` fingerprint over the turn structure so the
``(id, version)`` upsert against ``POST /v1/conversations`` is rejected when
the dev edits the spec without bumping ``id``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Union

Role = Literal["user", "agent"]

# Assertion predicate receives the agent's response for one turn. May be sync
# or async. Returns True / False / raises (counts as 'errored').
AssertionPredicate = Callable[["AgentResponse"], Union[bool, Awaitable[bool]]]

# Judge: receives the whole replay; returns a score + reason. Runs once per
# replay against the dev's LLM credentials — xray never holds them.
JudgePredicate = Callable[["ReplayResult"], Union["JudgeOutcome", Awaitable["JudgeOutcome"]]]


@dataclass(frozen=True)
class AudioRef:
    """How to source the user-side audio for a ``user`` turn.

    ``kind="recorded"`` points at a pre-recorded file on disk. ``kind="tts"``
    asks the runtime to synth from ``Turn.text`` (and cache the bytes
    next to the test for stable re-runs).
    """

    kind: Literal["recorded", "tts"]
    path: str | None = None
    voice_id: str | None = None


@dataclass(frozen=True)
class Turn:
    """One step in the Conversation."""

    role: Role
    text: str | None = None
    key: str | None = None
    audio: AudioRef | None = None
    assertion: AssertionPredicate | None = None
    assertion_name: str | None = None

    @classmethod
    def user(cls, text: str, *, key: str | None = None, audio: AudioRef | None = None) -> "Turn":
        return cls(role="user", text=text, key=key, audio=audio)


def expect_agent_turn(
    *,
    key: str | None = None,
    assertion: AssertionPredicate | None = None,
    assertion_name: str | None = None,
) -> Turn:
    """Placeholder for an agent-side turn — agent text/audio is observed at
    runtime, not pre-written. ``assertion`` is evaluated against the captured
    agent response after the turn completes.
    """
    return Turn(
        role="agent",
        key=key,
        assertion=assertion,
        assertion_name=assertion_name,
    )


@dataclass
class Conversation:
    """The dev-authored test definition."""

    id: str
    turns: list[Turn]
    title: str | None = None
    judge: JudgePredicate | None = None
    # Overridable so the dev can pin a version even when the structure changes
    # — but the default is the fingerprint, which is what the docs recommend.
    version: str = field(default_factory=str)

    def __post_init__(self) -> None:
        if not self.version:
            object.__setattr__(self, "version", self.compute_version())
        if len(self.turns) == 0:
            raise ValueError("Conversation must have at least one turn")

    def compute_version(self) -> str:
        """Stable fingerprint over the turn structure. Matches the
        server-side canonical encoding (JSON-stringified turn array)."""
        canonical = json.dumps(
            [_turn_to_wire(t, include_callable_marker=True) for t in self.turns],
            separators=(",", ":"),
            sort_keys=True,
        )
        return "v" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]

    def to_spec_payload(self) -> dict[str, Any]:
        """POST body for ``/v1/conversations`` — matches the server
        Valibot schema."""
        return {
            "id": self.id,
            "version": self.version,
            **({"title": self.title} if self.title is not None else {}),
            "turns": [_turn_to_wire(t, include_callable_marker=False) for t in self.turns],
        }


def _turn_to_wire(turn: Turn, *, include_callable_marker: bool) -> dict[str, Any]:
    """Project a Turn onto the wire shape the server expects (or a
    fingerprint-stable variant when ``include_callable_marker`` is true:
    the assertion function reference is collapsed to a boolean presence
    marker so two callables with identical signatures fingerprint the
    same)."""
    out: dict[str, Any] = {"role": turn.role}
    if turn.text is not None:
        out["text"] = turn.text
    if turn.key is not None:
        out["key"] = turn.key
    if turn.audio is not None:
        out["audio"] = _audio_to_wire(turn.audio)
    if include_callable_marker and turn.assertion is not None:
        out["__has_assertion"] = True
    return out


def _audio_to_wire(audio: AudioRef) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": audio.kind}
    if audio.path is not None:
        out["path"] = audio.path
    if audio.voice_id is not None:
        out["voiceId"] = audio.voice_id
    return out


@dataclass
class AgentResponse:
    """What the runtime observed for one agent-side turn."""

    transcript: str
    audio_path: str | None = None
    duration_ms: int | None = None


@dataclass
class TurnRecord:
    """Per-turn outcome recorded during a replay."""

    idx: int
    role: Role
    key: str | None
    transcript: str | None
    audio_path: str | None
    assertion: "AssertionOutcome | None" = None


@dataclass
class AssertionOutcome:
    name: str
    status: Literal["passed", "failed", "errored"]
    message: str | None = None


@dataclass
class JudgeOutcome:
    status: Literal["passed", "failed", "errored"]
    score: int | None = None
    reason: str | None = None
    error: str | None = None


@dataclass
class ReplayResult:
    """Snapshot of one replay's outcome handed to a judge."""

    conversation_id: str
    conversation_version: str
    turns: list[TurnRecord]
    transcript: str | None = None
