"""``xray.run(...)`` — convenience orchestrator.

1. POST the Conversation (multipart: ``spec`` JSON + one file part per
   ``RecordedAudio`` turn). Server hashes the canonical turn JSON (with
   sha256 of each WAV's bytes substituted in) and returns
   ``conversation_hash``.
2. POST the Replay referencing ``conversation_hash``. Server returns
   ``replay_id``.
3. Bind the runtime + wire the driver-side OTEL pipeline.
4. Run the runtime.
5. Upload the runtime's mixdown WAV (if produced).
6. Kick off server-side analyze + wait via SSE for the terminal event
   (best-effort; SSE drop demotes us to the legacy path).
7. Fetch the rich per-turn server view (tool calls, model usage, stage
   timings) and merge it into each ``AgentResponse``.
8. Evaluate per-turn assertions.
9. Fire the per-replay judge (if any).
10. PATCH the Replay row with final status (409 tolerated — server owns
    lifecycle).

Type safety: every outbound JSON body is a ``TypedDict``; the
sync/async assertion predicates are typed via the aliases in
``xray.conversation``; runtime hooks are dispatched via the
``RuntimeBindable`` Protocol.

Snake_case wire — bodies sent to xray use ``conversation_hash`` /
``run_config`` / ``failure_reason`` etc. Matches the server's Valibot
schemas in `src/server/**/*.types.ts`.
"""

from __future__ import annotations

import contextvars
import datetime as _dt
import inspect
import io
import json
import logging
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal, TypeAlias, TypedDict, TypeVar

import httpx
from opentelemetry import context as otel_context
from opentelemetry.context.context import Context
from opentelemetry.sdk.trace import TracerProvider
from pydantic import BaseModel, Field, ValidationError
from typing_extensions import NotRequired

from xray._json import JsonObject
from xray.config import RunConfig
from xray.conversation import (
    AgentResponse,
    AssertionOutcome,
    AssertionPredicate,
    Conversation,
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
    XrayError,
    XrayServerError,
)
from xray.otel import attach_replay_baggage
from xray.otel import install as install_otel
from xray.runtime.base import Runtime, RuntimeBindable, RuntimeResult

logger = logging.getLogger(__name__)

# Mirrors MAX_AUDIO_BYTES in src/server/audio/audio.types.ts. The server
# enforces the cap independently; we surface a typed error before sending
# bytes the server will reject anyway.
MAX_AUDIO_BYTES = 50 * 1024 * 1024

ReplayStatus: TypeAlias = Literal["completed", "failed"]
ReplayLifecycleState: TypeAlias = Literal[
    "pending", "running", "recording_uploaded", "analyzing", "completed", "failed"
]


# ─── Wire payloads (snake_case) ───────────────────────────────────────


class ReplayCreateBody(TypedDict):
    """Body of ``POST /v1/replays`` — references a pre-uploaded conversation
    by content hash. The SDK POSTs ``/v1/conversations`` first (multipart
    with optional audio bytes) and reuses the returned hash here."""

    conversation_hash: str
    run_config: NotRequired[JsonObject]


class _ConversationUpsertResponse(BaseModel):
    """Inbound shape for ``POST /v1/conversations``."""

    hash: str


class _ReplayCreateResponse(BaseModel):
    """Inbound shape for ``POST /v1/replays``."""

    id: str


class ReplayPatchBody(TypedDict):
    """PATCH /v1/replays/:id body. Mirrors the server's
    ``UpdateReplayRequestSchema`` exactly (per
    ``sdk/python/.claude/rules/typed-boundaries.md`` §1) — no fields the
    server doesn't accept."""

    lifecycle_state: ReplayLifecycleState
    failure_reason: NotRequired[FailureReason]
    finished_at: NotRequired[str]


# ─── Orchestrator result ──────────────────────────────────────────────


@dataclass(frozen=True)
class RunResult:
    """What ``run(...)`` returns. ``id`` matches the Replay row in xray."""

    id: str
    conversation_hash: str
    name: str
    status: ReplayStatus
    assertions: list[AssertionOutcome]
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
        # Pre-flight every RecordedAudio reference before creating the
        # Replay row — a missing file later would leave an orphan.
        _check_recorded_audio_exists(conversation)

        # 1. Upsert Conversation (multipart). Server hashes the canonical
        # turn JSON (with sha256 substituted for each RecordedAudio's bytes)
        # and returns the conversation hash. The SDK never hashes anything.
        spec = conversation.to_conversation_spec_payload()
        with _open_recorded_audio_files(conversation) as audio_files:
            # `files=` (with spec as a string field) forces httpx to encode
            # multipart/form-data even when no RecordedAudio turns are present;
            # passing `data={"spec": ...}` alongside an empty `files=` would
            # collapse to x-www-form-urlencoded and the server would 400 it.
            files: list[tuple[str, tuple[str | None, str | io.BufferedReader, str]]] = [
                ("spec", (None, json.dumps(spec, separators=(",", ":")), "application/json")),
                *audio_files,
            ]
            r = await client.post("/v1/conversations", files=files)
            # Failure before the replay row exists — no PATCH path to surface
            # `failure_reason` through. Wrap in a typed XrayError so the dev
            # sees an SDK contract violation, not a raw httpx exception.
            _raise_for_status_typed(r, "POST /v1/conversations")
        conversation_upsert = _read_response(
            r.json(), _ConversationUpsertResponse, "POST /v1/conversations"
        )
        conversation_hash = conversation_upsert.hash

        # 2. Create Replay eagerly so the runtime can propagate the id
        # via OTEL baggage BEFORE the dev's agent emits its first span.
        create_body: ReplayCreateBody = {"conversation_hash": conversation_hash}
        if run_config is not None:
            create_body["run_config"] = run_config.to_wire()
        r = await client.post("/v1/replays", json=create_body)
        _raise_for_status_typed(r, "POST /v1/replays")
        replay_create = _read_response(r.json(), _ReplayCreateResponse, "POST /v1/replays")
        replay_id = replay_create.id

        # 3. Bind runtime.
        if isinstance(runtime, RuntimeBindable):
            runtime.bind(
                replay_id=replay_id,
                conversation_hash=conversation_hash,
            )

        # 3b. Wire the driver-side OTEL pipeline. Mirrors what
        # ``xray.attach`` does on the agent side — install the OTLP/JSON
        # exporter + baggage processor, set the replay-scope baggage so
        # spans emitted by the runtime (e.g. ``xray.turn`` for user
        # turns) carry ``xray.replay.id`` and route to this replay.
        tracer_provider: TracerProvider = install_otel(endpoint=xray_url)
        baggage_token: contextvars.Token[Context] = attach_replay_baggage(
            replay_id=replay_id,
            conversation_hash=conversation_hash,
            modality="voice",
        )

        # 4. Run the runtime. Typed errors surface their own
        # `failure_reason`; everything else falls through to a generic
        # `driver_aborted` PATCH — no substring matching, per the
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
            status, failure_reason = "failed", "driver_aborted"
        finally:
            await runtime.aclose()
            # Flush driver-side spans + detach baggage before we proceed
            # to fetch the enrichment so any in-flight ``xray.turn``
            # exports land in xray first.
            tracer_provider.force_flush(timeout_millis=10_000)
            otel_context.detach(baggage_token)

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
                status, failure_reason = "failed", "driver_aborted"

        # 6. Kick off server-side VAD/turn analysis if we uploaded audio.
        # Best-effort: a 4xx / 5xx here (e.g. server in dev mode, endpoint not
        # yet deployed, or replay state mismatch) demotes us to the legacy
        # path — the assertions below still get the old per-turn enrichment
        # view without VAD-derived turn boundaries.
        analysis_kicked = False
        if (
            status == "completed"
            and runtime_result is not None
            and runtime_result.full_audio_path is not None
        ):
            try:
                r = await client.post(f"/v1/replays/{replay_id}/analyze")
                if r.is_success:
                    analysis_kicked = True
                else:
                    logger.warning(
                        "POST /v1/replays/%s/analyze returned %s; skipping VAD wait",
                        replay_id,
                        r.status_code,
                    )
            except Exception:
                logger.warning("could not start analysis for replay %s", replay_id, exc_info=True)

        # 7. Wait for analysis to terminate via SSE. Also best-effort.
        # If the server stamped the row `failed` (e.g. bunqueue exhausted
        # retries → onFailed → markReplayFailed), we must flip the SDK-side
        # status to match: the server's `updateReplay` blocks
        # terminal→different-terminal PATCHes with 409, so PATCHing
        # `lifecycle_state='completed'` on a row already `failed` would
        # raise. Don't override `failure_reason` — the server already wrote
        # `max_attempts_exceeded`, and our PATCH omits the field so the
        # server's value is preserved.
        if analysis_kicked:
            try:
                terminal = await _wait_for_analysis(client, replay_id)
            except Exception:
                logger.warning("SSE wait failed for replay %s", replay_id, exc_info=True)
            else:
                if terminal == "failed" and status == "completed":
                    logger.warning(
                        "server marked replay %s `failed` during analysis; "
                        "demoting SDK status to match",
                        replay_id,
                    )
                    status = "failed"

        # 8. Fetch the rich per-turn view and merge into each agent
        # response so assertions see tool_calls / model_usage / stage
        # timings.
        responses: list[AgentResponse] = (
            list(runtime_result.responses) if runtime_result is not None else []
        )
        enrichment = await _fetch_replay_enrichment(client, replay_id)
        responses = _merge_enrichment_into_responses(
            conversation=conversation, responses=responses, enrichment=enrichment
        )

        # 9. Per-turn assertions.
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

        # 10. Judge.
        if conversation.judge is not None and status == "completed":
            replay_result = ReplayResult(
                conversation_hash=conversation_hash,
                name=conversation.name,
                turns=turn_records,
                transcript=(runtime_result.full_transcript if runtime_result is not None else None),
            )
            # Judge is dev-authored Python — must not strand the replay row in
            # a non-terminal state if it raises. Outcome is side-effected onto
            # OTEL spans inside `_evaluate_judge`; the orchestrator's job is
            # to still PATCH so the row reaches a terminal lifecycle.
            try:
                await _evaluate_judge(conversation.judge, replay_result)
            except Exception:
                logger.exception("judge raised for replay %s", replay_id)

        # 11. PATCH.
        patch_body = _build_patch_body(status=status, failure_reason=failure_reason)
        r = await client.patch(f"/v1/replays/{replay_id}", json=patch_body)
        if r.status_code == 409:
            # Server already owns the lifecycle — either still `analyzing`
            # (SSE wait at step 7 didn't see the terminal event in time) or
            # already terminal with a different `lifecycle_state` than we
            # would have written. Server's truth wins; trying to force ours
            # would mean re-fetching + re-PATCHing in a loop with no guarantee
            # of convergence. Log and move on.
            logger.info(
                "PATCH /v1/replays/%s returned 409 — server owns lifecycle, accepting its state",
                replay_id,
            )
        else:
            _raise_for_status_typed(r, f"PATCH /v1/replays/{replay_id}")

        return RunResult(
            id=replay_id,
            conversation_hash=conversation_hash,
            name=conversation.name,
            status=status,
            assertions=assertions,
            url=f"{xray_url}/replays/{replay_id}",
        )


# ─── Helpers ──────────────────────────────────────────────────────────


_TResponse = TypeVar("_TResponse", bound=BaseModel)


def _read_response(raw: object, model_cls: type[_TResponse], endpoint: str) -> _TResponse:
    try:
        return model_cls.model_validate(raw)
    except ValidationError as e:
        raise XrayError(f"{endpoint} response malformed: {e}") from e


def _raise_for_status_typed(response: httpx.Response, endpoint: str) -> None:
    """Wrap ``response.raise_for_status()``'s ``HTTPStatusError`` into a typed
    ``XrayServerError`` so the dev sees an SDK contract violation rather than a
    raw httpx exception. No-op on success."""
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise XrayServerError(
            f"{endpoint} failed: {e.response.status_code} {e.response.text[:500]}",
            status_code=e.response.status_code,
        ) from e


async def _evaluate_judge(judge: JudgePredicate, replay_result: ReplayResult) -> object:
    """Invoke the conversation-level judge with the assembled ReplayResult.

    The return value is currently unused — judges side-effect into their own
    tracking systems. Defined here so behavior stays in one place when the
    SDK eventually surfaces judge outcomes back to the dev.
    """
    outcome = judge(replay_result)
    if inspect.isawaitable(outcome):
        return await outcome
    return outcome


def _build_patch_body(
    *,
    status: ReplayStatus,
    failure_reason: FailureReason | None,
) -> ReplayPatchBody:
    body: ReplayPatchBody = {"lifecycle_state": status}
    if failure_reason is not None:
        body["failure_reason"] = failure_reason
    return body


class _SseStateData(BaseModel):
    """Inbound shape for the SSE `state` event's JSON body."""

    lifecycle_state: str | None = None


def _terminal_state_from_payload(raw: str) -> Literal["completed", "failed"] | None:
    """Best-effort parse of the SSE `state` event's JSON body. Returns the
    terminal lifecycle if the payload's `lifecycle_state` is `completed` or
    `failed`, ``None`` otherwise (including on parse failure).
    """
    try:
        decoded = _SseStateData.model_validate_json(raw)
    except (ValueError, ValidationError):
        return None
    if decoded.lifecycle_state == "completed":
        return "completed"
    if decoded.lifecycle_state == "failed":
        return "failed"
    return None


async def _wait_for_analysis(
    client: httpx.AsyncClient,
    replay_id: str,
    *,
    timeout_s: float = 300.0,
) -> Literal["completed", "failed"] | None:
    """Stream `GET /v1/replays/:id/events` and return the terminal lifecycle
    the server reached (`"completed"` or `"failed"`). Returns ``None`` if the
    stream closed without ever emitting a terminal `state` event.

    The caller uses the return value to keep the SDK-side `status` consistent
    with the server's row: if VAD failed, the server has already stamped
    `lifecycle_state='failed'` + `failure_reason='max_attempts_exceeded'` via
    `markReplayFailed`, and the subsequent PATCH must echo `'failed'` —
    otherwise the server's `ReplayLifecycleTransitionError` guard rejects the
    PATCH with a 409.

    Pure-stdlib SSE parser — one `event: <type>\\n` line followed by one
    `data: <json>\\n` line, blank line terminates the message. Heartbeats
    (`:` prefix) are skipped.
    """
    async with client.stream(
        "GET",
        f"/v1/replays/{replay_id}/events",
        timeout=timeout_s,
        headers={"accept": "text/event-stream"},
    ) as response:
        response.raise_for_status()
        event_type: str | None = None
        async for raw_line in response.aiter_lines():
            line = raw_line.rstrip("\r")
            if line == "":
                event_type = None
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event_type = line[len("event:") :].strip()
                continue
            if line.startswith("data:") and event_type == "state":
                terminal = _terminal_state_from_payload(line[len("data:") :].strip())
                if terminal is not None:
                    return terminal
        return None


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


def _check_recorded_audio_exists(conversation: Conversation) -> None:
    for idx, turn in enumerate(conversation.turns):
        audio = turn.audio
        if not isinstance(audio, RecordedAudio):
            continue
        path = Path(audio.path)
        if not path.is_file():
            raise AudioMissingError(f"recorded audio file not found: {path}", turn_idx=idx)


@contextmanager
def _open_recorded_audio_files(
    conversation: Conversation,
) -> Generator[list[tuple[str, tuple[str, io.BufferedReader, str]]], None, None]:
    """Yield an httpx ``files=`` list with each RecordedAudio opened binary.

    Format: ``[(upload_key, (filename, fileobj, mime))]``. ExitStack closes
    every handle in LIFO order on exit, exception or not.
    """
    with ExitStack() as stack:
        files = [
            (upload_key, (Path(p).name, stack.enter_context(Path(p).open("rb")), "audio/wav"))
            for upload_key, p in conversation.recorded_audio_uploads()
        ]
        yield files


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


# ─── Server enrichment (tool calls + model usage + stage timings) ────


@dataclass
class _ReplayEnrichment:
    """Per-turn rich rows scraped from ``GET /v1/replays/:id``."""

    tool_calls_by_turn: dict[int, list[ToolCall]]
    model_usage_by_turn: dict[int, list[ModelUsage]]
    stage_timings_by_turn: dict[int, StageTimings]


class _ToolCallRow(BaseModel):
    turn_idx: int | None = None
    name: str = ""
    args_json: str | None = None
    result_json: str | None = None
    latency_ms: int | None = None


class _ModelUsageRow(BaseModel):
    turn_idx: int | None = None
    provider: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


class _SpanRow(BaseModel):
    name: str = ""
    attributes_json: str | None = None
    started_at: str | None = None
    ended_at: str | None = None


class _ReplayEnrichmentBody(BaseModel):
    tool_calls: list[_ToolCallRow] = Field(default_factory=list[_ToolCallRow])
    model_usage: list[_ModelUsageRow] = Field(default_factory=list[_ModelUsageRow])
    spans: list[_SpanRow] = Field(default_factory=list[_SpanRow])


class _XrayStageAttrs(BaseModel):
    xray_turn_idx: int | None = Field(default=None, alias="xray.turn.idx")

    model_config = {"populate_by_name": True}


async def _fetch_replay_enrichment(client: httpx.AsyncClient, replay_id: str) -> _ReplayEnrichment:
    """``GET /v1/replays/:id`` and bin the tool_calls / model_usage rows
    by ``turn_idx``. Best-effort: on any failure returns empty maps. Any
    assertion that depends on tool_calls / model_usage / stage_timings
    will see the empty view and likely evaluate `False`, so callers should
    treat a missing-enrichment warning in the log as a possible cause of
    unexpected assertion failures.

    A 404 is treated as "analysis still in progress / never ran" and
    logged at info — the row genuinely has no rows yet. Every other
    exception (network error, schema drift, malformed JSON) is logged at
    warning with the exception class name so the operator can distinguish
    "no data yet" from "the fetch broke"."""
    try:
        r = await client.get(f"/v1/replays/{replay_id}")
        r.raise_for_status()
        body = _ReplayEnrichmentBody.model_validate(r.json())
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            logger.info(
                "replay %s has no enrichment yet (404); assertions get thin view", replay_id
            )
        else:
            logger.warning(
                "GET /v1/replays/%s returned %s; assertions get thin view",
                replay_id,
                e.response.status_code,
            )
        return _ReplayEnrichment({}, {}, {})
    except Exception as e:
        logger.warning(
            "failed to fetch replay enrichment for %s (%s: %s); assertions get thin view",
            replay_id,
            type(e).__name__,
            e,
        )
        return _ReplayEnrichment({}, {}, {})

    tool_calls_by_turn: dict[int, list[ToolCall]] = {}
    for tc_row in body.tool_calls:
        if tc_row.turn_idx is None:
            continue
        tool_calls_by_turn.setdefault(tc_row.turn_idx, []).append(
            ToolCall(
                name=tc_row.name,
                args_json=tc_row.args_json,
                result_json=tc_row.result_json,
                latency_ms=tc_row.latency_ms,
            )
        )

    model_usage_by_turn: dict[int, list[ModelUsage]] = {}
    for mu_row in body.model_usage:
        if mu_row.turn_idx is None:
            continue
        model_usage_by_turn.setdefault(mu_row.turn_idx, []).append(
            ModelUsage(
                provider=mu_row.provider,
                model=mu_row.model,
                input_tokens=mu_row.input_tokens,
                output_tokens=mu_row.output_tokens,
                total_tokens=mu_row.total_tokens,
            )
        )

    # Stage timings ride on xray.stage.stt / xray.stage.tts spans.
    # Extract latencies from the spans array.
    stage_timings_by_turn: dict[int, StageTimings] = {}
    for span in body.spans:
        if not span.name.startswith("xray.stage."):
            continue
        stage = span.name.split(".", 2)[2]
        if span.attributes_json is None or span.started_at is None or span.ended_at is None:
            continue
        try:
            attrs = _XrayStageAttrs.model_validate_json(span.attributes_json)
        except ValidationError:
            continue
        if attrs.xray_turn_idx is None:
            continue
        try:
            dur_ms = (
                _dt.datetime.fromisoformat(span.ended_at.rstrip("Z"))
                - _dt.datetime.fromisoformat(span.started_at.rstrip("Z"))
            ).total_seconds() * 1000.0
        except ValueError:
            continue
        stage_timings_by_turn.setdefault(attrs.xray_turn_idx, {})[stage] = float(dur_ms)

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
    "MAX_AUDIO_BYTES",
    "ReplayPatchBody",
    "ReplayStatus",
    "RunResult",
    "run",
]
