"""Smoke test for the orchestrator using a stubbed runtime and respx-mocked
xray endpoints. Verifies the request shape we send to xray + the order of
the SDK's lifecycle calls."""

from __future__ import annotations

import httpx
import pytest
import respx

from xray import Conversation, Turn, expect_agent_turn, run
from xray.conversation import AgentResponse, JudgeOutcome, ReplayResult
from xray.runtime.base import Runtime, RuntimeResult


class StubRuntime(Runtime):
    """Returns canned agent responses without touching LiveKit."""

    def __init__(self, responses: list[AgentResponse]) -> None:
        self.responses = responses
        self.bound: dict[str, str] | None = None
        self.closed = False

    def bind(self, *, replay_id: str, conversation_id: str, conversation_version: str) -> None:
        self.bound = {
            "replay_id": replay_id,
            "conversation_id": conversation_id,
            "conversation_version": conversation_version,
        }

    async def run(self, conversation: Conversation) -> RuntimeResult:
        return RuntimeResult(responses=self.responses)

    async def aclose(self) -> None:
        self.closed = True


@respx.mock
def test_run_creates_conversation_then_replay_then_patches_with_judge():
    conv = Conversation(
        id="alpha",
        turns=[
            Turn.user("hi", key="u0"),
            expect_agent_turn(
                key="a0",
                assertion=lambda agent: "confirmed" in agent.transcript,
                assertion_name="confirms",
            ),
        ],
        judge=lambda r: JudgeOutcome(status="passed", score=99),
    )
    runtime = StubRuntime(
        responses=[
            AgentResponse(transcript=""),
            AgentResponse(transcript="confirmed at 7pm"),
        ]
    )

    post_conv = respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    post_replay = respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(
            201,
            json={
                "id": "00000000-0000-0000-0000-000000000001",
                "conversationId": conv.id,
                "conversationVersion": conv.version,
                "status": "running",
                "failureReason": None,
                "modality": "voice",
                "startedAt": "2026-05-18T12:00:00.000Z",
                "finishedAt": None,
                "audioPath": None,
                "transcript": None,
                "runConfig": None,
                "judge": {"status": None, "score": None, "reason": None, "error": None},
                "turns": [],
                "assertions": [],
                "toolCalls": [],
                "modelUsage": [],
                "spans": [],
            },
        )
    )
    patch_replay = respx.patch(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-000000000001"
    ).mock(return_value=httpx.Response(200, json={}))

    result = run(conversation=conv, runtime=runtime, xray_url="http://xray.local")

    assert post_conv.called
    assert post_replay.called
    assert patch_replay.called

    patch_call = patch_replay.calls[0]
    body = patch_call.request.content.decode()
    assert '"status":"completed"' in body
    assert '"judge"' in body
    assert '"score":99' in body

    assert result.status == "completed"
    assert len(result.assertions) == 1
    assert result.assertions[0].status == "passed"
    assert result.judge is not None
    assert result.judge.score == 99

    assert runtime.bound is not None
    assert runtime.bound["replay_id"] == "00000000-0000-0000-0000-000000000001"
    assert runtime.closed is True


@respx.mock
def test_run_marks_failed_when_runtime_raises():
    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])

    class BoomRuntime(Runtime):
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise RuntimeError("agent_not_joined")

        async def aclose(self) -> None: ...

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000ff"})
    )
    patch_replay = respx.patch(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000ff"
    ).mock(return_value=httpx.Response(200, json={}))

    result = run(conversation=conv, runtime=BoomRuntime(), xray_url="http://xray.local")
    assert result.status == "failed"
    assert patch_replay.called
    body = patch_replay.calls[0].request.content.decode()
    assert '"status":"failed"' in body
    # The raised message matches the server's failureReason picklist
    # ("agent_not_joined"), so it survives the classifier verbatim.
    assert '"failureReason":"agent_not_joined"' in body


@respx.mock
def test_run_falls_back_to_runtime_error_for_unmapped_exception():
    """A free-form exception message that isn't in the failureReason picklist
    is classified as `runtime_error`, not echoed verbatim — otherwise the
    server would reject the PATCH for an invalid failureReason."""
    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])

    class BoomRuntime(Runtime):
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise RuntimeError("connection refused to wss://livekit.example")

        async def aclose(self) -> None: ...

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000ee"})
    )
    patch_replay = respx.patch(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000ee"
    ).mock(return_value=httpx.Response(200, json={}))

    run(conversation=conv, runtime=BoomRuntime(), xray_url="http://xray.local")
    body = patch_replay.calls[0].request.content.decode()
    assert '"failureReason":"runtime_error"' in body


@pytest.mark.parametrize(
    "passes,expected",
    [(True, "passed"), (False, "failed")],
)
@respx.mock
def test_assertion_outcomes(passes, expected):
    conv = Conversation(
        id="x",
        turns=[
            Turn.user("hi", key="u0"),
            expect_agent_turn(key="a0", assertion=lambda agent: passes, assertion_name="n"),
        ],
    )
    runtime = StubRuntime(
        responses=[AgentResponse(transcript=""), AgentResponse(transcript="ok")]
    )
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000aa"})
    )
    respx.patch("http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000aa").mock(
        return_value=httpx.Response(200, json={})
    )

    result = run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.assertions[0].status == expected
