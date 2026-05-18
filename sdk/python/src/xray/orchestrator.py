"""``xray.run(...)`` — convenience orchestrator.

1. POST the Conversation (idempotent upsert).
2. POST the Replay, get back ``replay_id``.
3. Bind the runtime + run it.
4. Evaluate per-turn assertions, then the per-replay judge (if any).
5. PATCH the Replay row with final status + judge.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from xray.conversation import (
    AgentResponse,
    AssertionOutcome,
    Conversation,
    JudgeOutcome,
    ReplayResult,
    TurnRecord,
)
from xray.runtime.base import Runtime

logger = logging.getLogger(__name__)


@dataclass
class RunResult:
    """What ``run(...)`` returns. ``id`` matches the Replay row in xray."""

    id: str
    conversation_id: str
    conversation_version: str
    status: str
    assertions: list[AssertionOutcome]
    judge: JudgeOutcome | None


def run(
    *,
    conversation: Conversation,
    runtime: Runtime,
    xray_url: str = "http://localhost:8080",
    run_config: dict[str, Any] | None = None,
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
    run_config: dict[str, Any] | None = None,
) -> RunResult:
    async with httpx.AsyncClient(base_url=xray_url, timeout=30.0) as client:
        # 1. Upsert Conversation.
        spec = conversation.to_spec_payload()
        r = await client.post("/v1/conversations", json=spec)
        r.raise_for_status()

        # 2. Create Replay eagerly so the SDK can propagate the id BEFORE
        #    the runtime joins the room.
        body: dict[str, Any] = {
            "conversationId": conversation.id,
            "conversationVersion": conversation.version,
            "modality": "voice",
        }
        if run_config is not None:
            body["runConfig"] = run_config
        r = await client.post("/v1/replays", json=body)
        r.raise_for_status()
        replay_body = r.json()
        replay_id: str = replay_body["id"]

        # 3. Bind runtime if it accepts the hook (LiveKitRuntime does).
        bind = getattr(runtime, "bind", None)
        if callable(bind):
            bind(
                replay_id=replay_id,
                conversation_id=conversation.id,
                conversation_version=conversation.version,
            )

        # 4. Run the runtime.
        status: str = "completed"
        failure_reason: str | None = None
        runtime_result = None
        try:
            runtime_result = await runtime.run(conversation)
        except Exception as e:  # noqa: BLE001
            logger.exception("runtime failed during replay %s", replay_id)
            status = "failed"
            failure_reason = str(e) or "runtime_error"
        finally:
            await runtime.aclose()

        # 5. Evaluate per-turn assertions on the runtime's recorded responses.
        assertions: list[AssertionOutcome] = []
        responses = runtime_result.responses if runtime_result is not None else []
        turn_records: list[TurnRecord] = []
        for idx, (turn, response) in enumerate(zip(conversation.turns, responses, strict=False)):
            record = TurnRecord(
                idx=idx,
                role=turn.role,
                key=turn.key,
                transcript=response.transcript if response is not None else None,
                audio_path=response.audio_path if response is not None else None,
            )
            if turn.assertion is not None and response is not None:
                outcome = await _evaluate_assertion(turn.assertion, turn.assertion_name or f"turn_{idx}", response)
                record.assertion = outcome
                assertions.append(outcome)
            turn_records.append(record)

        # 6. Run the judge (if any) against the full replay.
        judge_outcome: JudgeOutcome | None = None
        if conversation.judge is not None and status == "completed":
            replay_result = ReplayResult(
                conversation_id=conversation.id,
                conversation_version=conversation.version,
                turns=turn_records,
                transcript=runtime_result.full_transcript if runtime_result is not None else None,
            )
            judge_outcome = await _evaluate_judge(conversation.judge, replay_result)

        # 7. PATCH the Replay with the final outcome.
        patch_body: dict[str, Any] = {"status": status}
        if failure_reason is not None:
            patch_body["failureReason"] = "runtime_error"
        if judge_outcome is not None:
            patch_body["judge"] = {
                "status": judge_outcome.status,
                **({"score": judge_outcome.score} if judge_outcome.score is not None else {}),
                **({"reason": judge_outcome.reason} if judge_outcome.reason is not None else {}),
                **({"error": judge_outcome.error} if judge_outcome.error is not None else {}),
            }
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


async def _evaluate_assertion(
    predicate: Any,
    name: str,
    response: AgentResponse,
) -> AssertionOutcome:
    try:
        result = predicate(response)
        if inspect.isawaitable(result):
            result = await result
        return AssertionOutcome(name=name, status="passed" if result else "failed")
    except Exception as e:  # noqa: BLE001
        return AssertionOutcome(name=name, status="errored", message=str(e))


async def _evaluate_judge(predicate: Any, replay: ReplayResult) -> JudgeOutcome:
    try:
        result = predicate(replay)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, JudgeOutcome):
            return result
        return JudgeOutcome(status="errored", error="judge did not return a JudgeOutcome")
    except Exception as e:  # noqa: BLE001
        return JudgeOutcome(status="errored", error=str(e))
