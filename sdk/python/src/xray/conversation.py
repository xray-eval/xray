"""Test-definition primitives.

A ``Conversation`` is the dev-authored spec: an ordered list of ``Turn``\\ s,
plus per-turn assertion predicates and a per-replay LLM judge. The SDK
auto-computes the ``version`` fingerprint over the turn structure so the
``(id, version)`` upsert against ``POST /v1/conversations`` is rejected when
the dev edits the spec without bumping ``id``.

Type safety: ``AudioRef`` is a discriminated union (``RecordedAudio`` vs
``TtsAudio``), and wire payloads are ``TypedDict``\\ s. See
``sdk/python/.claude/rules/typed-boundaries.md``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal, TypeAlias, TypedDict

from typing_extensions import NotRequired, assert_never

Role: TypeAlias = Literal["user", "agent"]
AssertionStatus: TypeAlias = Literal["passed", "failed", "errored"]

# Assertion predicate receives the agent's response for one turn. May be sync
# or async. Returns True / False / raises (counts as 'errored').
AssertionPredicate: TypeAlias = Callable[["AgentResponse"], bool | Awaitable[bool]]

# Judge: receives the whole replay; returns a score + reason. Runs once per
# replay against the dev's LLM credentials — xray never holds them.
JudgePredicate: TypeAlias = Callable[["ReplayResult"], "JudgeOutcome | Awaitable[JudgeOutcome]"]


# ─── AudioRef: discriminated union ────────────────────────────────────


@dataclass(frozen=True)
class RecordedAudio:
    """Point at a pre-recorded WAV on disk. Must be 48 kHz / mono / 16-bit."""

    path: str
    kind: Literal["recorded"] = field(default="recorded", init=False)


@dataclass(frozen=True)
class TtsAudio:
    """Synthesize from ``Turn.text`` via OpenAI TTS. Cached per
    conversation at ``~/.cache/xray-py/<conv>/<fingerprint>.wav``."""

    voice_id: str | None = None
    kind: Literal["tts"] = field(default="tts", init=False)


AudioRef: TypeAlias = RecordedAudio | TtsAudio


# ─── Turn + Conversation ──────────────────────────────────────────────


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
    def user(
        cls,
        text: str,
        *,
        key: str | None = None,
        audio: AudioRef | None = None,
    ) -> Turn:
        return cls(role="user", text=text, key=key, audio=audio)

    @classmethod
    def agent(
        cls,
        *,
        key: str | None = None,
        assertion: AssertionPredicate | None = None,
        assertion_name: str | None = None,
    ) -> Turn:
        """Placeholder for an agent-side turn — agent text/audio is observed
        at runtime, not pre-written. ``assertion`` is evaluated against the
        captured agent response after the turn completes.
        """
        return cls(
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
    version: str = ""

    def __post_init__(self) -> None:
        if not self.version:
            self.version = self.compute_version()
        if len(self.turns) == 0:
            raise ValueError("Conversation must have at least one turn")

    def compute_version(self) -> str:
        """Stable fingerprint over the turn structure. Matches the
        server-side canonical encoding (JSON-stringified turn array)."""
        canonical = json.dumps(
            [_turn_to_fingerprint(t) for t in self.turns],
            separators=(",", ":"),
            sort_keys=True,
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
        return f"v{digest}"

    def to_spec_payload(self) -> ConversationSpecBody:
        """POST body for ``/v1/conversations`` — matches the server
        Valibot schema."""
        body: ConversationSpecBody = {
            "id": self.id,
            "version": self.version,
            "turns": [_turn_to_wire(t) for t in self.turns],
        }
        if self.title is not None:
            body["title"] = self.title
        return body


# ─── Wire payloads (TypedDicts) ───────────────────────────────────────


class AudioWirePayload(TypedDict):
    kind: Literal["recorded", "tts"]
    path: NotRequired[str]
    voice_id: NotRequired[str]


class TurnWirePayload(TypedDict):
    role: Role
    text: NotRequired[str]
    key: NotRequired[str]
    audio: NotRequired[AudioWirePayload]


class TurnFingerprintPayload(TypedDict):
    """Like ``TurnWirePayload`` but with a presence marker for callable
    assertions so two functions with identical signatures fingerprint
    the same. Distinct TypedDict (not a subclass) so the optional marker
    is statically expressible without widening ``TurnWirePayload``."""

    role: Role
    text: NotRequired[str]
    key: NotRequired[str]
    audio: NotRequired[AudioWirePayload]
    _has_assertion: NotRequired[bool]


class ConversationSpecBody(TypedDict):
    id: str
    version: str
    turns: list[TurnWirePayload]
    title: NotRequired[str]


# ─── Wire encoders ────────────────────────────────────────────────────


def _audio_to_wire(audio: AudioRef) -> AudioWirePayload:
    match audio:
        case RecordedAudio(path=path):
            return {"kind": "recorded", "path": path}
        case TtsAudio(voice_id=voice_id):
            # Narrow inside the arm — pyright doesn't propagate the
            # voice_id field type through the match pattern, so
            # destructure-then-guard is what keeps NotRequired[str] honest.
            if voice_id is None:
                return {"kind": "tts"}
            return {"kind": "tts", "voice_id": voice_id}
        case _:
            assert_never(audio)


def _turn_to_wire(turn: Turn) -> TurnWirePayload:
    out: TurnWirePayload = {"role": turn.role}
    if turn.text is not None:
        out["text"] = turn.text
    if turn.key is not None:
        out["key"] = turn.key
    if turn.audio is not None:
        out["audio"] = _audio_to_wire(turn.audio)
    return out


def _turn_to_fingerprint(turn: Turn) -> TurnFingerprintPayload:
    out: TurnFingerprintPayload = {"role": turn.role}
    if turn.text is not None:
        out["text"] = turn.text
    if turn.key is not None:
        out["key"] = turn.key
    if turn.audio is not None:
        out["audio"] = _audio_to_wire(turn.audio)
    if turn.assertion is not None:
        out["_has_assertion"] = True
    return out


# ─── Runtime-produced records ─────────────────────────────────────────


@dataclass(frozen=True)
class ToolCall:
    """One tool/function invocation by the agent during a turn.

    Mirrors the server-persisted row hydrated from ``gen_ai.tool`` spans
    (or whatever the recognized vocabulary captured). Hydrated by the
    orchestrator from ``GET /v1/replays/:id`` before assertions run."""

    name: str
    args_json: str | None
    result_json: str | None
    latency_ms: int | None


@dataclass(frozen=True)
class ModelUsage:
    """Per-call LLM usage captured from gen_ai.* / langfuse.* spans."""

    provider: str | None
    model: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None


StageTimings: TypeAlias = dict[str, float]


@dataclass(frozen=True)
class AgentResponse:
    """What the runtime + server observed for one agent-side turn.

    ``transcript`` comes from the runtime (LiveKit transcription
    publication). ``tool_calls`` / ``model_usage`` / ``stage_timings``
    come from xray's persisted view of the spans the agent emitted
    during this turn — the orchestrator fetches ``GET /v1/replays/:id``
    after the runtime returns and projects per-turn slices into each
    response.

    No per-turn ``audio_path``: xray ships one WAV per replay (the
    mixdown) and slices it in the inspector by per-turn timestamps.
    """

    transcript: str
    duration_ms: int | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)
    model_usage: tuple[ModelUsage, ...] = field(default_factory=tuple)
    stage_timings: StageTimings = field(default_factory=dict[str, float])


@dataclass
class AssertionOutcome:
    name: str
    status: AssertionStatus
    message: str | None = None


@dataclass
class TurnRecord:
    """Per-turn outcome recorded during a replay."""

    idx: int
    role: Role
    key: str | None
    transcript: str | None
    assertion: AssertionOutcome | None = None


@dataclass
class JudgeOutcome:
    status: AssertionStatus
    score: int | None = None
    reason: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ReplayResult:
    """Snapshot of one replay's outcome handed to a judge."""

    conversation_id: str
    conversation_version: str
    turns: list[TurnRecord]
    transcript: str | None = None


__all__ = [
    "AgentResponse",
    "AssertionOutcome",
    "AssertionPredicate",
    "AssertionStatus",
    "AudioRef",
    "AudioWirePayload",
    "Conversation",
    "ConversationSpecBody",
    "JudgeOutcome",
    "JudgePredicate",
    "ModelUsage",
    "RecordedAudio",
    "ReplayResult",
    "Role",
    "StageTimings",
    "ToolCall",
    "Turn",
    "TurnRecord",
    "TurnWirePayload",
    "TtsAudio",
]
