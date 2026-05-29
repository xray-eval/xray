"""Test-definition primitives.

A ``Conversation`` is the dev-authored spec: an ordered list of ``Turn``\\ s
with per-turn ``Assertion``\\ s, plus conversation-level ``Judge``\\ s.
The server identifies the conversation by a content hash it computes
itself — the SDK ships the spec (and any ``RecordedAudio`` bytes via
multipart file parts) and reads the hash back from the server's
response. The ``name`` field is a free-form display label only.

Evaluation runs **server-side** as of spec 0001. The SDK declares
``Assertion`` / ``Judge`` variants and ships them on the wire; the
server executes them after the run completes and returns the verdict
via the `evaluation_complete` SSE event. The orchestrator translates
that payload into the :class:`ReplayResult` dataclass returned by
``xray.run``.

Type safety: every wire payload is a ``TypedDict``; assertion/judge
constructors are typed classmethods on frozen dataclasses. See
``sdk/python/.claude/rules/typed-boundaries.md``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, TypeAlias, TypedDict

from typing_extensions import NotRequired, assert_never

from xray._json import JsonObject, JsonValue

Role: TypeAlias = Literal["user", "agent"]
EvaluationStatus: TypeAlias = Literal["passed", "failed", "errored"]


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


# ─── Assertion: declarative, server-evaluated ────────────────────────


@dataclass(frozen=True)
class Assertion:
    """A declarative check the server runs against one turn of the replay.

    Closed catalog — every variant ships as a tagged JSON object on the
    wire and is dispatched server-side. Construct via the classmethods;
    never instantiate ``Assertion`` directly.
    """

    kind: str
    # Variant params — what's stored depends on `kind`. Kept opaque here so
    # the wire encoder can re-emit the JSON without re-deriving per
    # variant. The classmethods enforce that the right keys are populated.
    params: JsonObject

    # Fail-fast bounds checks at construction time. The server enforces the
    # same bounds and rejects bad payloads with a 400, but a server 400
    # surfaces hundreds of lines away from the assertion's source line and
    # gives the dev no clue which assertion was wrong. These checks pin the
    # error to the actual `Assertion.X(...)` call site.

    @classmethod
    def contains(cls, text: str, *, case_insensitive: bool = True) -> Assertion:
        if not text:
            raise ValueError("Assertion.contains: text must be non-empty")
        return cls(kind="contains", params={"text": text, "case_insensitive": case_insensitive})

    @classmethod
    def not_contains(cls, text: str, *, case_insensitive: bool = True) -> Assertion:
        if not text:
            raise ValueError("Assertion.not_contains: text must be non-empty")
        return cls(
            kind="not_contains",
            params={"text": text, "case_insensitive": case_insensitive},
        )

    @classmethod
    def equals(cls, text: str, *, case_insensitive: bool = True, trim: bool = True) -> Assertion:
        if not text:
            raise ValueError("Assertion.equals: text must be non-empty")
        return cls(
            kind="equals",
            params={"text": text, "case_insensitive": case_insensitive, "trim": trim},
        )

    @classmethod
    def regex(cls, pattern: str, *, flags: str = "") -> Assertion:
        if not pattern:
            raise ValueError("Assertion.regex: pattern must be non-empty")
        return cls(kind="regex", params={"pattern": pattern, "flags": flags})

    @classmethod
    def tool_called(cls, name: str) -> Assertion:
        if not name:
            raise ValueError("Assertion.tool_called: name must be non-empty")
        return cls(kind="tool_called", params={"name": name})

    @classmethod
    def tool_not_called(cls, name: str) -> Assertion:
        if not name:
            raise ValueError("Assertion.tool_not_called: name must be non-empty")
        return cls(kind="tool_not_called", params={"name": name})

    @classmethod
    def tool_args_match(cls, name: str, args: JsonObject) -> Assertion:
        if not name:
            raise ValueError("Assertion.tool_args_match: name must be non-empty")
        return cls(kind="tool_args_match", params={"name": name, "args": args})

    @classmethod
    def max_latency_ms(cls, max_ms: int) -> Assertion:
        if max_ms < 1:
            raise ValueError(
                f"Assertion.max_latency_ms: max_ms must be >= 1 (got {max_ms})",
            )
        return cls(kind="max_latency_ms", params={"max_ms": max_ms})

    @classmethod
    def max_ttft_ms(cls, max_ms: int) -> Assertion:
        if max_ms < 1:
            raise ValueError(
                f"Assertion.max_ttft_ms: max_ms must be >= 1 (got {max_ms})",
            )
        return cls(kind="max_ttft_ms", params={"max_ms": max_ms})

    def to_wire(self) -> AssertionWirePayload:
        # Spread first so a `kind` in params can't clobber the dispatch tag.
        return {**self.params, "kind": self.kind}


# ─── Judge: conversation-level ──────────────────────────────────────


@dataclass(frozen=True)
class Judge:
    """A conversation-level evaluator the server runs once per replay.

    v1 ships ``text_match`` only — emotion / safety / custom-prompt
    judges land as additional classmethods + server-side variants in
    future PRs.
    """

    kind: str
    params: JsonObject

    @classmethod
    def text_match(
        cls,
        reference: str,
        *,
        rubric: str | None = None,
        pass_score: int = 70,
    ) -> Judge:
        # Fail-fast at construction so the dev sees the source line of the
        # bad Judge.text_match(...), not a server 400 round-trip later.
        if not reference:
            raise ValueError("Judge.text_match: reference must be non-empty")
        if rubric is not None and len(rubric) == 0:
            raise ValueError(
                "Judge.text_match: rubric must be non-empty when provided",
            )
        if pass_score < 0 or pass_score > 100:
            raise ValueError(
                f"Judge.text_match: pass_score must be in 0..100 (got {pass_score})",
            )
        params: JsonObject = {"reference": reference, "pass_score": pass_score}
        if rubric is not None:
            params["rubric"] = rubric
        return cls(kind="text_match", params=params)

    def to_wire(self) -> JudgeWirePayload:
        return {**self.params, "kind": self.kind}


# ─── Turn + Conversation ──────────────────────────────────────────────


@dataclass(frozen=True)
class Turn:
    """One step in the Conversation."""

    role: Role
    text: str | None = None
    key: str | None = None
    audio: AudioRef | None = None
    assertions: tuple[Assertion, ...] = ()

    @classmethod
    def user(
        cls,
        text: str,
        *,
        key: str | None = None,
        audio: AudioRef | None = None,
        assertions: tuple[Assertion, ...] = (),
    ) -> Turn:
        return cls(role="user", text=text, key=key, audio=audio, assertions=assertions)

    @classmethod
    def agent(
        cls,
        *,
        key: str | None = None,
        assertions: tuple[Assertion, ...] = (),
    ) -> Turn:
        """Placeholder for an agent-side turn — agent text/audio is observed
        at runtime, not pre-written. ``assertions`` are evaluated
        server-side against the captured agent response after the run.
        """
        return cls(role="agent", key=key, assertions=assertions)


@dataclass(frozen=True)
class Conversation:
    """The dev-authored test definition.

    Server-computed identity: the server hashes the canonical conversation
    spec (turns + judges) and returns the hash on the ``/v1/conversations``
    upsert. Adding/removing/changing assertions or judges changes the
    hash — they're part of the test identity, not metadata.

    ``live`` marks a mic session driven by :func:`xray.run_live`: there is
    no script, so ``turns`` may be empty and no assertions/judges run. The
    server salts the hash for live conversations so each session is its own
    row.

    Frozen so a stale ``Conversation`` reference can't silently drift after
    being handed to the orchestrator.
    """

    name: str
    turns: list[Turn]
    judges: tuple[Judge, ...] = ()
    live: bool = False

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Conversation.name must be non-empty")
        # Live sessions have no script — empty turns are valid only when live.
        if len(self.turns) == 0 and not self.live:
            raise ValueError("Conversation must have at least one turn")

    def to_conversation_spec_payload(self) -> ConversationSpecBody:
        """JSON ``spec`` part of the multipart POST to ``/v1/conversations``.

        Recorded-audio turns are emitted as ``{kind: "recorded",
        upload_key: f"audio_<idx>"}`` so the server can match each turn
        to the corresponding multipart file part.
        """
        body: ConversationSpecBody = {
            "name": self.name,
            "turns": [_turn_to_wire(t, idx) for idx, t in enumerate(self.turns)],
        }
        if len(self.judges) > 0:
            body["judges"] = [j.to_wire() for j in self.judges]
        if self.live:
            body["live"] = True
        return body

    def recorded_audio_uploads(self) -> list[tuple[str, str]]:
        """Pairs of (upload_key, file_path) for each RecordedAudio turn."""
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

# Assertion / Judge wire shapes are tagged-by-kind open objects — the
# server's Valibot v.variant("kind", ...) validates them. Statically typing
# every variant here would duplicate the catalog without buying
# discriminated narrowing (the SDK never reads its own assertions back).
AssertionWirePayload: TypeAlias = dict[str, JsonValue]
JudgeWirePayload: TypeAlias = dict[str, JsonValue]


class TurnWirePayload(TypedDict):
    role: Role
    text: NotRequired[str]
    key: NotRequired[str]
    audio: NotRequired[AudioWirePayload]
    assertions: NotRequired[list[AssertionWirePayload]]


class ConversationSpecBody(TypedDict):
    name: str
    turns: list[TurnWirePayload]
    judges: NotRequired[list[JudgeWirePayload]]
    live: NotRequired[bool]


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
    if len(turn.assertions) > 0:
        out["assertions"] = [a.to_wire() for a in turn.assertions]
    return out


# ─── Runtime-produced records (informational only) ───────────────────
# Kept for runtime APIs (LiveKitRuntime returns AgentResponse per turn).
# The orchestrator no longer reads these — assertion + judge evaluation
# happens server-side. Devs who want to introspect runtime output can
# still do so via `RuntimeResult.responses`.


@dataclass(frozen=True)
class ToolCall:
    """One tool/function invocation observed by the runtime during a turn."""

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
    """Runtime-captured per-turn artifacts.

    Kept on ``RuntimeResult.responses`` for devs who want to inspect raw
    runtime output. The orchestrator does NOT use this for evaluation —
    assertions + judges run server-side from the uploaded WAV + spans.
    """

    transcript: str
    duration_ms: int | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)
    model_usage: tuple[ModelUsage, ...] = field(default_factory=tuple)
    stage_timings: StageTimings = field(default_factory=dict[str, float])


# ─── Server-computed verdict dataclasses ─────────────────────────────


@dataclass(frozen=True)
class AssertionOutcome:
    """One assertion's verdict, as returned by the server."""

    turn_idx: int
    assertion_idx: int
    kind: str
    status: EvaluationStatus
    message: str | None


@dataclass(frozen=True)
class JudgeOutcome:
    """One judge's verdict, as returned by the server."""

    judge_idx: int
    kind: str
    status: EvaluationStatus
    score: int | None
    reason: str | None


@dataclass(frozen=True)
class TurnMetrics:
    """Per-turn timing metrics computed server-side."""

    turn_idx: int
    role: Role
    agent_response_ms: int | None
    ttft_ms: int | None
    interrupted: bool


@dataclass(frozen=True)
class ReplayResult:
    """What ``xray.run(...)`` returns when the chain completes.

    ``passed`` is the aggregate: true iff every assertion *and* every
    judge ran to a `passed` status. `errored` counts as not-passed —
    a missing transcript or a crashing judge means the test as a unit
    didn't establish the expected behavior.

    No exceptions are raised on assertion failures — devs assert on
    ``result.passed`` in pytest. Infrastructure failures (server crashed
    the chain before reaching evaluation) raise
    :class:`xray.errors.ReplayEvaluationError` with the underlying
    ``failure_reason``.
    """

    replay_id: str
    conversation_hash: str
    passed: bool
    assertions: tuple[AssertionOutcome, ...]
    judges: tuple[JudgeOutcome, ...]
    metrics: tuple[TurnMetrics, ...]


def format_failures(result: ReplayResult) -> str:
    """Render non-passed assertion + judge outcomes as a multi-line string.

    Use with the pytest idiom ``assert result.passed, format_failures(result)``.
    """
    lines: list[str] = []
    for a in result.assertions:
        if a.status == "passed":
            continue
        msg = a.message or "(no message)"
        lines.append(
            f"  turn {a.turn_idx} assertion[{a.assertion_idx}] {a.kind}: {a.status} — {msg}"
        )
    for j in result.judges:
        if j.status == "passed":
            continue
        reason = j.reason or "(no reason)"
        score = "n/a" if j.score is None else str(j.score)
        lines.append(f"  judge[{j.judge_idx}] {j.kind}: {j.status} score={score} — {reason}")
    if len(lines) == 0:
        return "all assertions and judges passed"
    return "replay failed:\n" + "\n".join(lines)


__all__ = [
    "AgentResponse",
    "Assertion",
    "AssertionOutcome",
    "AssertionWirePayload",
    "AudioRef",
    "AudioWirePayload",
    "Conversation",
    "ConversationSpecBody",
    "EvaluationStatus",
    "Judge",
    "JudgeOutcome",
    "JudgeWirePayload",
    "ModelUsage",
    "RecordedAudio",
    "RecordedAudioWirePayload",
    "ReplayResult",
    "Role",
    "StageTimings",
    "ToolCall",
    "TtsAudio",
    "TtsAudioWirePayload",
    "Turn",
    "TurnMetrics",
    "TurnWirePayload",
    "format_failures",
]
