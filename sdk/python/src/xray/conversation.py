"""Test-definition primitives.

A ``Conversation`` is the dev-authored spec: an ordered list of ``Turn``\\ s,
plus per-turn assertion predicates. The SDK computes a content hash over
the turns (including sha256 of per-turn ``RecordedAudio`` bytes) that
identifies the conversation server-side — there is no dev-set id. The
``name`` field is a free-form display label only.

Type safety: ``AudioRef`` is a discriminated union (``RecordedAudio`` vs
``TtsAudio``), and wire payloads are ``TypedDict``\\ s. See
``sdk/python/.claude/rules/typed-boundaries.md``.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, TypeAlias, TypedDict

from typing_extensions import NotRequired, assert_never

from ._json import JsonObject
from .errors import AudioMissingError

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

    Identity is the SHA-256 content hash over the turn array (including
    sha256 of per-turn ``RecordedAudio`` bytes). ``name`` is a free-form
    display label only — renaming does NOT change the hash.

    Frozen so a later field reassignment can't silently invalidate the
    ``hash`` property's value.
    """

    name: str
    turns: list[Turn]
    judge: JudgePredicate | None = None

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Conversation.name must be non-empty")
        if len(self.turns) == 0:
            raise ValueError("Conversation must have at least one turn")

    @property
    def hash(self) -> str:
        """Content hash. Mirrors the server-side canonicalization — see
        ``tests/fixtures/hash-parity.json`` for the cross-language wire
        contract.

        Per-file audio bytes-sha256 is memoized by ``(path, mtime_ns,
        size)`` in :data:`_AUDIO_SHA256_CACHE` so an unchanged WAV isn't
        re-read on each access.
        """
        return _hash_turns_wire([_turn_to_wire(t) for t in self.turns])

    def to_replay_create_payload(
        self,
        *,
        modality: Literal["voice"] = "voice",
        run_config: JsonObject | None = None,
    ) -> ReplayCreateBody:
        """POST body for ``/v1/replays``. The server recomputes the hash
        from ``turns`` — we do NOT send the SDK-computed hash on the wire
        (trust boundary)."""
        body: ReplayCreateBody = {
            "name": self.name,
            "turns": [_turn_to_wire(t) for t in self.turns],
            "modality": modality,
        }
        if run_config is not None:
            body["run_config"] = run_config
        return body


# ─── Wire payloads (TypedDicts) ───────────────────────────────────────


class RecordedAudioWirePayload(TypedDict):
    kind: Literal["recorded"]
    path: str
    sha256: str


class TtsAudioWirePayload(TypedDict):
    kind: Literal["tts"]
    voice_id: NotRequired[str]


AudioWirePayload: TypeAlias = RecordedAudioWirePayload | TtsAudioWirePayload


class TurnWirePayload(TypedDict):
    role: Role
    text: NotRequired[str]
    key: NotRequired[str]
    audio: NotRequired[AudioWirePayload]


class ReplayCreateBody(TypedDict):
    name: str
    turns: list[TurnWirePayload]
    modality: Literal["voice"]
    run_config: NotRequired[JsonObject]


# ─── Wire encoders ────────────────────────────────────────────────────


def _audio_to_wire(audio: AudioRef) -> AudioWirePayload:
    match audio:
        case RecordedAudio(path=path):
            return {"kind": "recorded", "path": path, "sha256": _sha256_file(path)}
        case TtsAudio(voice_id=voice_id):
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


# ─── Canonical encoding + audio bytes sha256 (cached per file) ────────


def _canonical_turns_json(turns_wire: list[TurnWirePayload]) -> str:
    """Canonical JSON encoding of an already-built turn-wire payload list.

    Pinned wire contract shared with the TS server — see
    ``src/server/conversations/conversations.service.ts::canonicalStringify``
    and ``tests/fixtures/hash-parity.json`` for the parity vector.
    """
    return json.dumps(turns_wire, separators=(",", ":"), sort_keys=True, ensure_ascii=True)


def _hash_turns_wire(turns_wire: list[TurnWirePayload]) -> str:
    """SHA-256 hex over :func:`_canonical_turns_json`."""
    return hashlib.sha256(_canonical_turns_json(turns_wire).encode("utf-8")).hexdigest()


_AUDIO_SHA256_CACHE: dict[tuple[str, int, int], str] = {}


def _sha256_file(path: str) -> str:
    """SHA-256 hex of file bytes, cached by (path, mtime_ns, size).

    Cache key includes mtime + size so editing the file invalidates the
    entry on the next access. Raises :class:`AudioMissingError` if the
    file is missing or unreadable.
    """
    p = Path(path)
    try:
        st = os.stat(p)
    except OSError as e:
        raise AudioMissingError(f"recorded audio file not readable: {p}") from e
    key = (str(p), st.st_mtime_ns, st.st_size)
    cached = _AUDIO_SHA256_CACHE.get(key)
    if cached is not None:
        return cached
    h = hashlib.sha256()
    try:
        with p.open("rb") as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                h.update(chunk)
    except OSError as e:
        raise AudioMissingError(f"recorded audio file not readable: {p}") from e
    digest = h.hexdigest()
    _AUDIO_SHA256_CACHE[key] = digest
    return digest


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
    "RecordedAudioWirePayload",
    "ReplayCreateBody",
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
