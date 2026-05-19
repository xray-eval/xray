"""``xray.run(...)`` — convenience orchestrator.

1. POST the Conversation (idempotent upsert).
2. POST the Replay, get back ``replay_id``.
3. Bind the runtime + run it.
4. Upload the runtime's mixdown WAV (if produced).
5. Evaluate per-turn assertions, then the per-replay judge (if any).
6. PATCH the Replay row with final status + judge.

Type safety: every outbound JSON body is a ``TypedDict``; the
sync/async assertion + judge predicates are typed via the aliases in
``xray.conversation``; runtime hooks are dispatched via the
``RuntimeBindable`` Protocol; status branches end in ``assert_never``.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, NotRequired, TypeAlias, TypedDict, TypeGuard

import httpx
from pydantic import BaseModel, ValidationError

from xray._json import JsonObject
from xray.conversation import (
    AgentResponse,
    AssertionOutcome,
    AssertionPredicate,
    AssertionStatus,
    Conversation,
    JudgeOutcome,
    JudgePredicate,
    RecordedAudio,
    ReplayResult,
    TurnRecord,
)
from xray.errors import (
    FAILURE_REASONS,
    AudioMissingError,
    AudioTooLargeError,
    FailureReason,
    VersionFingerprintMismatchError,
    XrayError,
)
from xray.runtime.base import Runtime, RuntimeBindable, RuntimeResult

logger = logging.getLogger(__name__)

# Mirrors MAX_AUDIO_BYTES in src/server/audio/audio.types.ts. The server
# enforces the cap independently; we surface a typed error before sending
# bytes the server will reject anyway.
MAX_AUDIO_BYTES: Final[int] = 50 * 1024 * 1024

ReplayStatus: TypeAlias = Literal["completed", "failed"]


# ─── Wire payloads ────────────────────────────────────────────────────


class ReplayCreateBody(TypedDict):
    conversationId: str
    conversationVersion: str
    modality: Literal["voice"]
    runConfig: NotRequired[JsonObject]


class _ReplayCreateResponse(BaseModel):
    """Inbound shape for ``POST /v1/replays`` — pydantic validates the
    JSON at the trust boundary so the rest of the SDK receives a typed
    object, not ``Unknown``."""

    id: str


class JudgePatchBody(TypedDict):
    status: AssertionStatus
    score: NotRequired[int]
    reason: NotRequired[str]
    error: NotRequired[str]


class ReplayPatchBody(TypedDict):
    status: ReplayStatus
    failureReason: NotRequired[FailureReason]
    judge: NotRequired[JudgePatchBody]


# ─── Orchestrator result ──────────────────────────────────────────────


@dataclass(frozen=True)
class RunResult:
    """What ``run(...)`` returns. ``id`` matches the Replay row in xray."""

    id: str
    conversation_id: str
    conversation_version: str
    status: ReplayStatus
    assertions: list[AssertionOutcome]
    judge: JudgeOutcome | None


# ─── Public entrypoints ───────────────────────────────────────────────


def run(
    *,
    conversation: Conversation,
    runtime: Runtime,
    xray_url: str = "http://localhost:8080",
    run_config: JsonObject | None = None,
) -> RunResult:
    """Sync entrypoint. Wraps ``run_async`` in ``asyncio.run`` for users who
    don't want to set up their own event loop."""
    return asyncio.run(
        run_async(
            conversation=conversation,
            runtime=runtime,
            xray_url=xray_url,
            run_config=run_config,
        )
    )


async def run_async(
    *,
    conversation: Conversation,
    runtime: Runtime,
    xray_url: str = "http://localhost:8080",
    run_config: JsonObject | None = None,
) -> RunResult:
    async with httpx.AsyncClient(base_url=xray_url, timeout=30.0) as client:
        # 1. Upsert Conversation.
        spec = conversation.to_spec_payload()
        r = await client.post("/v1/conversations", json=spec)
        if r.status_code == 409:
            _raise_conversation_conflict(r, conversation)
        r.raise_for_status()

        # Pre-flight every RecordedAudio reference before the Replay row is
        # created — a missing file later would leave an orphan server-side.
        _check_recorded_audio_exists(conversation)

        # 2. Create Replay eagerly so the SDK can propagate the id BEFORE
        #    the runtime joins the room.
        create_body: ReplayCreateBody = {
            "conversationId": conversation.id,
            "conversationVersion": conversation.version,
            "modality": "voice",
        }
        if run_config is not None:
            create_body["runConfig"] = run_config
        r = await client.post("/v1/replays", json=create_body)
        r.raise_for_status()
        replay_id = _read_replay_id(r.json())

        # 3. Bind runtime if it implements RuntimeBindable.
        if isinstance(runtime, RuntimeBindable):
            runtime.bind(
                replay_id=replay_id,
                conversation_id=conversation.id,
                conversation_version=conversation.version,
            )

        # 4. Run the runtime. The broad fallback exists because we're
        #    orchestrating dev-provided code (runtime subclass) and a
        #    failed Replay must always be PATCHed — otherwise the row
        #    stays `running` forever and the inspector misleads.
        status: ReplayStatus = "completed"
        failure_reason: FailureReason | None = None
        runtime_result: RuntimeResult | None = None
        try:
            runtime_result = await runtime.run(conversation)
        except Exception as e:
            status, failure_reason = _record_failure(e, replay_id, step="runtime")
        finally:
            await runtime.aclose()

        # 5. Upload the full-replay mixdown if the runtime produced one.
        #    Failure here demotes the replay to `failed` rather than
        #    losing the row — the assertions still get persisted below.
        if (
            runtime_result is not None
            and runtime_result.full_audio_path is not None
            and status == "completed"
        ):
            try:
                await _upload_replay_audio(
                    client=client,
                    replay_id=replay_id,
                    audio_path=runtime_result.full_audio_path,
                )
            except Exception as e:
                status, failure_reason = _record_failure(e, replay_id, step="audio_upload")

        # 6. Evaluate per-turn assertions on the runtime's recorded responses.
        assertions: list[AssertionOutcome] = []
        responses: list[AgentResponse] = (
            runtime_result.responses if runtime_result is not None else []
        )
        turn_records: list[TurnRecord] = []
        for idx, (turn, response) in enumerate(zip(conversation.turns, responses, strict=False)):
            record = TurnRecord(
                idx=idx,
                role=turn.role,
                key=turn.key,
                transcript=response.transcript,
            )
            if turn.assertion is not None:
                outcome = await _evaluate_assertion(
                    turn.assertion, turn.assertion_name or f"turn_{idx}", response
                )
                record.assertion = outcome
                assertions.append(outcome)
            turn_records.append(record)

        # 7. Run the judge (if any) against the full replay.
        judge_outcome: JudgeOutcome | None = None
        if conversation.judge is not None and status == "completed":
            replay_result = ReplayResult(
                conversation_id=conversation.id,
                conversation_version=conversation.version,
                turns=turn_records,
                transcript=(runtime_result.full_transcript if runtime_result is not None else None),
            )
            judge_outcome = await _evaluate_judge(conversation.judge, replay_result)

        # 8. PATCH the Replay with the final outcome.
        patch_body = _build_patch_body(
            status=status, failure_reason=failure_reason, judge=judge_outcome
        )
        r = await client.patch(f"/v1/replays/{replay_id}", json=patch_body)
        r.raise_for_status()

        return RunResult(
            id=replay_id,
            conversation_id=conversation.id,
            conversation_version=conversation.version,
            status=status,
            assertions=assertions,
            judge=judge_outcome,
        )


# ─── Helpers ──────────────────────────────────────────────────────────


def _read_replay_id(raw: object) -> str:
    """Validate the ``POST /v1/replays`` response shape at the trust
    boundary — ``httpx`` hands us an untyped ``object``, and we don't
    propagate the field without checking it."""
    try:
        return _ReplayCreateResponse.model_validate(raw).id
    except ValidationError as e:
        raise XrayError(f"POST /v1/replays response malformed: {e}") from e


def _build_patch_body(
    *,
    status: ReplayStatus,
    failure_reason: FailureReason | None,
    judge: JudgeOutcome | None,
) -> ReplayPatchBody:
    body: ReplayPatchBody = {"status": status}
    if failure_reason is not None:
        body["failureReason"] = failure_reason
    if judge is not None:
        body["judge"] = _judge_to_wire(judge)
    return body


def _judge_to_wire(judge: JudgeOutcome) -> JudgePatchBody:
    body: JudgePatchBody = {"status": judge.status}
    if judge.score is not None:
        body["score"] = judge.score
    if judge.reason is not None:
        body["reason"] = judge.reason
    if judge.error is not None:
        body["error"] = judge.error
    return body


async def _upload_replay_audio(
    *, client: httpx.AsyncClient, replay_id: str, audio_path: str
) -> None:
    """POST a WAV mixdown to the replay-audio endpoint. Caps at
    MAX_AUDIO_BYTES locally so we surface ``AudioTooLargeError`` instead
    of a 413 from the server."""
    path = Path(audio_path)
    bytes_ = path.read_bytes()
    if len(bytes_) > MAX_AUDIO_BYTES:
        raise AudioTooLargeError(byte_size=len(bytes_), max_bytes=MAX_AUDIO_BYTES)
    response = await client.post(
        f"/v1/replays/{replay_id}/audio",
        content=bytes_,
        headers={"content-type": "audio/wav"},
    )
    response.raise_for_status()


def _record_failure(
    e: BaseException, replay_id: str, *, step: Literal["runtime", "audio_upload"]
) -> tuple[ReplayStatus, FailureReason]:
    """Log + classify a failure from the runtime or audio-upload step.

    Typed :class:`XrayError`\\ s surface their ``failure_reason`` directly;
    everything else goes through the picklist classifier."""
    logger.exception("%s failed during replay %s", step, replay_id)
    if isinstance(e, XrayError):
        return "failed", e.failure_reason
    return "failed", _classify_failure(e)


def _is_failure_reason(s: str) -> TypeGuard[FailureReason]:
    """Narrow a ``str`` into the closed ``FailureReason`` picklist —
    pyright doesn't propagate narrowing through a frozenset `in` check,
    so we make it explicit."""
    return s in FAILURE_REASONS


class _ConversationConflictBody(BaseModel):
    """Best-effort narrow of the 409 response from ``POST /v1/conversations``.
    Both fields are optional — the server may omit them when the conflict
    is detected purely by lookup. Any extra keys are ignored."""

    conversationId: str | None = None
    conversationVersion: str | None = None


def _raise_conversation_conflict(response: httpx.Response, conversation: Conversation) -> None:
    """Map a 409 from ``POST /v1/conversations`` to the typed
    ``VersionFingerprintMismatchError``. Falls back to the SDK's known
    ``(id, version)`` when the server body is missing the fields."""
    try:
        body = _ConversationConflictBody.model_validate(response.json())
    except (ValueError, ValidationError):
        body = _ConversationConflictBody()
    raise VersionFingerprintMismatchError(
        body.conversationId or conversation.id,
        body.conversationVersion or conversation.version,
    )


def _check_recorded_audio_exists(conversation: Conversation) -> None:
    """Pre-flight every ``RecordedAudio`` reference. Raises ``AudioMissingError``
    before the Replay row is created so a missing file can't produce an orphan
    replay."""
    for idx, turn in enumerate(conversation.turns):
        audio = turn.audio
        if not isinstance(audio, RecordedAudio):
            continue
        path = Path(audio.path)
        if not path.is_file():
            raise AudioMissingError(f"recorded audio file not found: {path}", turn_idx=idx)


def _classify_failure(e: BaseException) -> FailureReason:
    """Map a raw exception's message onto one of the server's
    ``failureReason`` picklist values; anything else falls back to
    ``runtime_error``. Typed :class:`XrayError` instances are handled
    earlier and don't reach this function."""
    message = str(e).strip()
    if _is_failure_reason(message):
        return message
    return "runtime_error"


async def _evaluate_assertion(
    predicate: AssertionPredicate,
    name: str,
    response: AgentResponse,
) -> AssertionOutcome:
    # Broad except is intentional: assertions are dev-authored lambdas
    # whose exception types we don't know; raising counts as 'errored'.
    try:
        result = predicate(response)
        if inspect.isawaitable(result):
            result = await result
        return AssertionOutcome(name=name, status="passed" if result else "failed")
    except Exception as e:
        return AssertionOutcome(name=name, status="errored", message=str(e))


async def _evaluate_judge(predicate: JudgePredicate, replay: ReplayResult) -> JudgeOutcome:
    # See `_evaluate_assertion` — same rationale for the broad except.
    try:
        result = predicate(replay)
        if inspect.isawaitable(result):
            return await result
        return result
    except Exception as e:
        return JudgeOutcome(status="errored", error=str(e))


__all__ = [
    "JudgePatchBody",
    "MAX_AUDIO_BYTES",
    "ReplayCreateBody",
    "ReplayPatchBody",
    "ReplayStatus",
    "RunResult",
    "run",
    "run_async",
]
