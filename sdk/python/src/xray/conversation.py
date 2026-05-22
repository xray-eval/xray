"""Test-definition primitives.

A ``Conversation`` is the dev-authored spec: an ordered list of ``Turn``\\ s,
plus per-turn assertion predicates. The server identifies the conversation
by a content hash it computes itself — the SDK ships the spec (and any
``RecordedAudio`` bytes via multipart file parts) and reads the hash back
from the server's response. The ``name`` field is a free-form display
label only.

Type safety: ``AudioRef`` is a discriminated union (``RecordedAudio`` vs
``TtsAudio``), and wire payloads are ``TypedDict``\\ s. See
``sdk/python/.claude/rules/typed-boundaries.md``.
"""

from __future__ import annotations

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
    conversation at ``~/.cache/xray-py/<hash>/<voice_id>.wav``."""

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


@dataclass(frozen=True)
class Conversation:
    """The dev-authored test definition.

    Server-computed identity: the server hashes the canonical turn JSON
    (with sha256 of any uploaded ``RecordedAudio`` bytes substituted in)
    and returns the result on `POST /v1/replays`. ``name`` is a free-form
    display label — renaming does NOT change identity.

    Frozen so a stale ``Conversation`` reference can't silently drift after
    being handed to the orchestrator.
    """

    name: str
    turns: list[Turn]
    judge: JudgePredicate | None = None

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Conversation.name must be non-empty")
        if len(self.turns) == 0:
            raise ValueError("Conversation must have at least one turn")

    def to_conversation_spec_payload(self) -> ConversationSpecBody:
        """JSON ``spec`` part of the multipart POST to ``/v1/conversations``.

        Recorded-audio turns are emitted as ``{kind: "recorded",
        upload_key: f"audio_<idx>"}`` so the server can match each turn
        to the corresponding multipart file part. The orchestrator builds
        the matching file-part dict from :func:`recorded_audio_uploads`.
        """
        return {
            "name": self.name,
            "turns": [_turn_to_wire(t, idx) for idx, t in enumerate(self.turns)],
        }

    def recorded_audio_uploads(self) -> list[tuple[str, str]]:
        """Pairs of (upload_key, file_path) for each RecordedAudio turn.

        The orchestrator opens each file and adds it to the multipart body
        under the matching ``upload_key``. Order is the turn order so
        ``upload_key`` is unique per conversation.
        """
        return [
            (_recorded_upload_key(idx), turn.audio.path)
            for idx, turn in enumerate(self.turns)
            if isinstance(turn.audio, RecordedAudio)
        ]


def _recorded_upload_key(turn_idx: int) -> str:
    return f"audio_{turn_idx}"


# ─── Wire payloads (TypedDicts) ───────────────────────────────────────


class RecordedAudioWirePayload(TypedDict):
    kind: Literal["recorded"]
    upload_key: str


class TtsAudioWirePayload(TypedDict):
    kind: Literal["tts"]
    voice_id: NotRequired[str]


AudioWirePayload: TypeAlias = RecordedAudioWirePayload | TtsAudioWirePayload


class TurnWirePayload(TypedDict):
    role: Role
    text: NotRequired[str]
    key: NotRequired[str]
    audio: NotRequired[AudioWirePayload]


class ConversationSpecBody(TypedDict):
    name: str
    turns: list[TurnWirePayload]


# ─── Wire encoders ────────────────────────────────────────────────────


def _audio_to_wire(audio: AudioRef, turn_idx: int) -> AudioWirePayload:
    match audio:
        case RecordedAudio():
            return {"kind": "recorded", "upload_key": _recorded_upload_key(turn_idx)}
        case TtsAudio(voice_id=voice_id):
            if voice_id is None:
                return {"kind": "tts"}
            return {"kind": "tts", "voice_id": voice_id}
        case _:
            assert_never(audio)


def _turn_to_wire(turn: Turn, turn_idx: int) -> TurnWirePayload:
    out: TurnWirePayload = {"role": turn.role}
    if turn.text is not None:
        out["text"] = turn.text
    if turn.key is not None:
        out["key"] = turn.key
    if turn.audio is not None:
        out["audio"] = _audio_to_wire(turn.audio, turn_idx)
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
    """What the runtime + server observed for one agent-side turn."""

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

    conversation_hash: str
    name: str
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
    "JudgeOutcome",
    "JudgePredicate",
    "ModelUsage",
    "RecordedAudio",
    "ConversationSpecBody",
    "RecordedAudioWirePayload",
    "ReplayResult",
    "Role",
    "StageTimings",
    "ToolCall",
    "TtsAudio",
    "TtsAudioWirePayload",
    "Turn",
    "TurnRecord",
    "TurnWirePayload",
]
