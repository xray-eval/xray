"""``xray.run(...)`` — convenience orchestrator.

1. POST the Conversation (idempotent upsert).
2. POST the Replay, get back ``replay_id``.
3. Bind the runtime + run it.
4. Upload the runtime's mixdown WAV (if produced).
5. Fetch the rich per-turn server view (tool calls, model usage, stage
   timings) and merge it into each ``AgentResponse``.
6. Evaluate per-turn assertions, then the per-replay judge (if any).
7. PATCH the Replay row with final status + judge.

Type safety: every outbound JSON body is a ``TypedDict``; the
sync/async assertion + judge predicates are typed via the aliases in
``xray.conversation``; runtime hooks are dispatched via the
``RuntimeBindable`` Protocol.

Snake_case wire — bodies sent to xray use ``conversation_id`` /
``conversation_version`` / ``run_config`` / ``failure_reason`` etc.
Matches the server's Valibot schemas in `src/server/**/*.types.ts`.
"""

from __future__ import annotations

import inspect
import logging
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal, TypeAlias, TypedDict

import httpx
from pydantic import BaseModel, ValidationError
from typing_extensions import NotRequired

from xray.config import RunConfig
from xray.conversation import (
    AgentResponse,
    AssertionOutcome,
    AssertionPredicate,
    AssertionStatus,
    Conversation,
    JudgeOutcome,
    JudgePredicate,
    ModelUsage,
    RecordedAudio,
    ReplayResult,
    StageTimings,
    ToolCall,
    TurnRecord,
)
from xray.errors import (
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
MAX_AUDIO_BYTES = 50 * 1024 * 1024

ReplayStatus: TypeAlias = Literal["completed", "failed"]


# ─── Wire payloads (snake_case) ───────────────────────────────────────


class ReplayCreateBody(TypedDict):
    conversation_id: str
    conversation_version: str
    modality: Literal["voice"]
    run_config: NotRequired[dict[str, object]]


class _ReplayCreateResponse(BaseModel):
    """Inbound shape for ``POST /v1/replays``."""

    id: str


class JudgePatchBody(TypedDict):
    status: AssertionStatus
    score: NotRequired[int]
    reason: NotRequired[str]
    error: NotRequired[str]


class ReplayPatchBody(TypedDict):
    status: ReplayStatus
    failure_reason: NotRequired[FailureReason]
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
    url: str | None = None


# ─── Public entrypoint ────────────────────────────────────────────────


async def run(
    *,
    conversation: Conversation,
    runtime: Runtime,
    xray_url: str = "http://localhost:8080",
    run_config: RunConfig | None = None,
) -> RunResult:
    """Drive one Replay end-to-end. Async — wrap in ``asyncio.run`` if you
    need a sync entry; the SDK no longer ships a sync ``run()`` because
    the implicit ``asyncio.run`` collided with already-running event
    loops (pytest-asyncio, Jupyter, LiveKit Agents).
    """
    xray_url = xray_url.rstrip("/")
    async with httpx.AsyncClient(base_url=xray_url, timeout=30.0) as client:
        # 1. Upsert Conversation.
        spec = conversation.to_spec_payload()
        r = await client.post("/v1/conversations", json=spec)
        if r.status_code == 409:
            _raise_conversation_conflict(r, conversation)
        r.raise_for_status()

        # Pre-flight every RecordedAudio reference before creating the
        # Replay row — a missing file later would leave an orphan.
        _check_recorded_audio_exists(conversation)

        # 2. Create Replay eagerly so the runtime can propagate the id.
        create_body: ReplayCreateBody = {
            "conversation_id": conversation.id,
            "conversation_version": conversation.version,
            "modality": "voice",
        }
        if run_config is not None:
            create_body["run_config"] = dict(run_config.to_wire())
        r = await client.post("/v1/replays", json=create_body)
        r.raise_for_status()
        replay_id = _read_replay_id(r.json())

        # 3. Bind runtime.
        if isinstance(runtime, RuntimeBindable):
            runtime.bind(
                replay_id=replay_id,
                conversation_id=conversation.id,
                conversation_version=conversation.version,
            )

        # 4. Run the runtime. Typed errors surface their own
        # `failure_reason`; everything else falls through to a generic
        # `runtime_error` PATCH — no substring matching, per the
        # restructure contract.
        status: ReplayStatus = "completed"
        failure_reason: FailureReason | None = None
        runtime_result: RuntimeResult | None = None
        try:
            runtime_result = await runtime.run(conversation)
        except XrayError as e:
            logger.exception("typed runtime failure on replay %s", replay_id)
            status, failure_reason = "failed", e.failure_reason
        except Exception:
            logger.exception("unclassified runtime failure on replay %s", replay_id)
            status, failure_reason = "failed", "runtime_error"
        finally:
            await runtime.aclose()

        # 5. Upload mixdown if produced.
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
            except XrayError as e:
                logger.exception("audio upload failed on replay %s", replay_id)
                status, failure_reason = "failed", e.failure_reason
            except Exception:
                logger.exception("audio upload errored on replay %s", replay_id)
                status, failure_reason = "failed", "runtime_error"

        # 6. Fetch the rich per-turn view and merge into each agent
        # response so assertions see tool_calls / model_usage / stage
        # timings.
        responses: list[AgentResponse] = (
            list(runtime_result.responses) if runtime_result is not None else []
        )
        enrichment = await _fetch_replay_enrichment(client, replay_id)
        responses = _merge_enrichment_into_responses(
            conversation=conversation, responses=responses, enrichment=enrichment
        )

        # 7. Per-turn assertions.
        assertions: list[AssertionOutcome] = []
        turn_records: list[TurnRecord] = []
        for idx, (turn, response) in enumerate(zip(conversation.turns, responses, strict=True)):
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

        # 8. Judge.
        judge_outcome: JudgeOutcome | None = None
        if conversation.judge is not None and status == "completed":
            replay_result = ReplayResult(
                conversation_id=conversation.id,
                conversation_version=conversation.version,
                turns=turn_records,
                transcript=(runtime_result.full_transcript if runtime_result is not None else None),
            )
            judge_outcome = await _evaluate_judge(conversation.judge, replay_result)

        # 9. PATCH.
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
            url=f"{xray_url}/replays/{replay_id}",
        )


# ─── Helpers ──────────────────────────────────────────────────────────


def _read_replay_id(raw: object) -> str:
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
        body["failure_reason"] = failure_reason
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


class _ConversationConflictBody(BaseModel):
    """Best-effort narrow of the snake_case 409 response."""

    conversation_id: str | None = None
    conversation_version: str | None = None


def _raise_conversation_conflict(response: httpx.Response, conversation: Conversation) -> None:
    try:
        body = _ConversationConflictBody.model_validate(response.json())
    except (ValueError, ValidationError):
        body = _ConversationConflictBody()
    raise VersionFingerprintMismatchError(
        body.conversation_id or conversation.id,
        body.conversation_version or conversation.version,
    )


def _check_recorded_audio_exists(conversation: Conversation) -> None:
    for idx, turn in enumerate(conversation.turns):
        audio = turn.audio
        if not isinstance(audio, RecordedAudio):
            continue
        path = Path(audio.path)
        if not path.is_file():
            raise AudioMissingError(f"recorded audio file not found: {path}", turn_idx=idx)


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
    try:
        result = predicate(replay)
        if inspect.isawaitable(result):
            return await result
        return result
    except Exception as e:
        return JudgeOutcome(status="errored", error=str(e))


# ─── Server enrichment (tool calls + model usage + stage timings) ────


@dataclass
class _ReplayEnrichment:
    """Per-turn rich rows scraped from ``GET /v1/replays/:id``."""

    tool_calls_by_turn: dict[int, list[ToolCall]]
    model_usage_by_turn: dict[int, list[ModelUsage]]
    stage_timings_by_turn: dict[int, StageTimings]


async def _fetch_replay_enrichment(client: httpx.AsyncClient, replay_id: str) -> _ReplayEnrichment:
    """``GET /v1/replays/:id`` and bin the tool_calls / model_usage rows
    by ``turn_idx``. Silent fallback to empty maps on any error — the
    happy path is best-effort enrichment, not a failure dimension."""
    try:
        r = await client.get(f"/v1/replays/{replay_id}")
        r.raise_for_status()
        body = r.json()
    except Exception:
        logger.warning(
            "failed to fetch replay enrichment for %s; assertions get thin view",
            replay_id,
        )
        return _ReplayEnrichment({}, {}, {})

    tool_calls_by_turn: dict[int, list[ToolCall]] = {}
    for row in body.get("tool_calls", []) or []:
        idx = row.get("turn_idx")
        if not isinstance(idx, int):
            continue
        tool_calls_by_turn.setdefault(idx, []).append(
            ToolCall(
                name=str(row.get("name", "")),
                args_json=row.get("args_json"),
                result_json=row.get("result_json"),
                latency_ms=row.get("latency_ms"),
            )
        )

    model_usage_by_turn: dict[int, list[ModelUsage]] = {}
    for row in body.get("model_usage", []) or []:
        idx = row.get("turn_idx")
        if not isinstance(idx, int):
            continue
        model_usage_by_turn.setdefault(idx, []).append(
            ModelUsage(
                provider=row.get("provider"),
                model=row.get("model"),
                input_tokens=row.get("input_tokens"),
                output_tokens=row.get("output_tokens"),
                total_tokens=row.get("total_tokens"),
            )
        )

    # Stage timings ride on xray.stage.stt / xray.stage.tts spans.
    # Extract latencies from the spans array.
    stage_timings_by_turn: dict[int, StageTimings] = {}
    import json as _json

    for span in body.get("spans", []) or []:
        name = span.get("name") or ""
        if not name.startswith("xray.stage."):
            continue
        stage = name.split(".", 2)[2]
        attrs_raw = span.get("attributes_json")
        if not isinstance(attrs_raw, str):
            continue
        try:
            attrs: dict[str, object] = _json.loads(attrs_raw)
        except Exception:
            continue
        idx_raw = attrs.get("xray.turn.idx")
        idx_val = (
            int(idx_raw)
            if isinstance(idx_raw, (int, str)) and str(idx_raw).lstrip("-").isdigit()
            else None
        )
        if idx_val is None:
            continue
        started = span.get("started_at")
        ended = span.get("ended_at")
        if not (isinstance(started, str) and isinstance(ended, str)):
            continue
        import datetime as _dt

        try:
            dur_ms = (
                _dt.datetime.fromisoformat(ended.rstrip("Z"))
                - _dt.datetime.fromisoformat(started.rstrip("Z"))
            ).total_seconds() * 1000.0
        except Exception:
            continue
        stage_timings_by_turn.setdefault(idx_val, {})[stage] = float(dur_ms)

    return _ReplayEnrichment(
        tool_calls_by_turn=tool_calls_by_turn,
        model_usage_by_turn=model_usage_by_turn,
        stage_timings_by_turn=stage_timings_by_turn,
    )


def _merge_enrichment_into_responses(
    *,
    conversation: Conversation,
    responses: list[AgentResponse],
    enrichment: _ReplayEnrichment,
) -> list[AgentResponse]:
    """Augment each ``AgentResponse`` with the per-turn server view."""
    out: list[AgentResponse] = []
    for idx, _turn in enumerate(conversation.turns):
        base = responses[idx] if idx < len(responses) else AgentResponse(transcript="")
        out.append(
            replace(
                base,
                tool_calls=tuple(enrichment.tool_calls_by_turn.get(idx, [])),
                model_usage=tuple(enrichment.model_usage_by_turn.get(idx, [])),
                stage_timings=dict(enrichment.stage_timings_by_turn.get(idx, {})),
            )
        )
    return out


__all__ = [
    "JudgePatchBody",
    "MAX_AUDIO_BYTES",
    "ReplayCreateBody",
    "ReplayPatchBody",
    "ReplayStatus",
    "RunResult",
    "run",
]
