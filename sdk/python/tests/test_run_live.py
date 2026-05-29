"""End-to-end tests for ``xray.run_live`` with the HTTP surface mocked.

Mirrors ``test_orchestrator`` but for the live path: no authored
Conversation, the server skips evaluation, and the returned
``ReplayResult`` carries empty assertions/judges.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from typing_extensions import override

from xray import Conversation, ReplayResult, run_live
from xray.errors import AgentNotJoinedError, AudioMissingError, ReplayEvaluationError
from xray.runtime.base import Runtime, RuntimeResult

_HASH = "a" * 64


class StubLiveRuntime(Runtime):
    """Stands in for LiveKitLiveRuntime: binds, is stoppable, returns a
    mixdown path without touching LiveKit or a microphone."""

    def __init__(
        self, *, full_audio_path: str | None = None, raise_on_run: Exception | None = None
    ) -> None:
        self.full_audio_path = full_audio_path
        self.raise_on_run = raise_on_run
        self.bound: dict[str, str] | None = None
        self.stop_requested = False
        self.closed = False

    def bind(self, *, replay_id: str, conversation_hash: str) -> None:
        self.bound = {"replay_id": replay_id, "conversation_hash": conversation_hash}

    def request_stop(self) -> None:
        self.stop_requested = True

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        if self.raise_on_run is not None:
            raise self.raise_on_run
        return RuntimeResult(responses=[], full_audio_path=self.full_audio_path)

    @override
    async def aclose(self) -> None:
        self.closed = True


def _replay_response(replay_id: str) -> dict[str, object]:
    return {"id": replay_id, "conversation_hash": _HASH, "lifecycle_state": "pending"}


def _eval_complete(
    replay_id: str, turns: list[dict[str, object]] | None = None
) -> dict[str, object]:
    return {
        "replay_id": replay_id,
        "conversation_hash": _HASH,
        "passed": True,
        "assertions": [],
        "judges": [],
        "metrics": {"turns": turns or []},
    }


def _sse(events: Iterable[tuple[str, dict[str, object]]]) -> bytes:
    lines: list[str] = []
    for event_type, data in events:
        lines.append(f"event: {event_type}")
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


def _make_wav(tmp_path: Path) -> Path:
    path = tmp_path / "live.wav"
    path.write_bytes(b"RIFF" + b"\x00" * 64)
    return path


def _conv_request_body(route: Any) -> str:
    # Multipart body carries the spec JSON part verbatim; a substring check
    # is enough to assert what the SDK sent.
    return bytes(route.calls.last.request.content).decode("utf-8", errors="replace")


@pytest.mark.asyncio
async def test_run_live_full_chain_returns_passed_result(tmp_path: Path):
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-0000000live1"

    with respx.mock(base_url="http://test.local") as mock:
        post_conv = mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json={"hash": _HASH})
        )
        post_replay = mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        post_audio = mock.post(f"/v1/replays/{replay_id}/audio").mock(
            return_value=httpx.Response(204)
        )
        post_analyze = mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        sse = mock.get(f"/v1/replays/{replay_id}/events").mock(
            return_value=httpx.Response(
                200,
                content=_sse(
                    [
                        (
                            "evaluation_complete",
                            {
                                "type": "evaluation_complete",
                                "result": _eval_complete(
                                    replay_id,
                                    turns=[
                                        {
                                            "turn_idx": 0,
                                            "role": "user",
                                            "agent_response_ms": None,
                                            "ttft_ms": None,
                                            "interrupted": False,
                                        }
                                    ],
                                ),
                            },
                        )
                    ]
                ),
                headers={"content-type": "text/event-stream"},
            )
        )

        runtime = StubLiveRuntime(full_audio_path=str(wav))
        result = await run_live(runtime=runtime, xray_url="http://test.local", name="explore")

    assert isinstance(result, ReplayResult)
    assert result.passed is True
    assert result.replay_id == replay_id
    assert result.assertions == ()
    assert result.judges == ()
    assert len(result.metrics) == 1
    assert result.metrics[0].role == "user"

    # The conversation POST declared live + the custom name + empty turns.
    body = _conv_request_body(post_conv)
    assert '"live":true' in body
    assert '"name":"explore"' in body
    assert '"turns":[]' in body

    assert runtime.bound == {"replay_id": replay_id, "conversation_hash": _HASH}
    assert runtime.closed is True
    assert post_replay.called
    assert post_audio.called
    assert post_analyze.called
    assert sse.called


@pytest.mark.asyncio
async def test_run_live_defaults_name_to_live_timestamp(tmp_path: Path):
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-0000000live2"

    with respx.mock(base_url="http://test.local") as mock:
        post_conv = mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json={"hash": _HASH})
        )
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j", "lifecycle_state": "analyzing"})
        )
        mock.get(f"/v1/replays/{replay_id}/events").mock(
            return_value=httpx.Response(
                200,
                content=_sse(
                    [
                        (
                            "evaluation_complete",
                            {"type": "evaluation_complete", "result": _eval_complete(replay_id)},
                        )
                    ]
                ),
                headers={"content-type": "text/event-stream"},
            )
        )

        await run_live(
            runtime=StubLiveRuntime(full_audio_path=str(wav)), xray_url="http://test.local"
        )

    body = _conv_request_body(post_conv)
    assert '"name":"live-' in body


@pytest.mark.asyncio
async def test_run_live_driver_failure_patches_and_raises():
    replay_id = "00000000-0000-0000-0000-0000000live3"

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(return_value=httpx.Response(200, json={"hash": _HASH}))
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        patch = mock.patch(f"/v1/replays/{replay_id}").mock(
            return_value=httpx.Response(200, json={})
        )

        runtime = StubLiveRuntime(raise_on_run=AgentNotJoinedError("room-1", 30.0))
        with pytest.raises(AgentNotJoinedError):
            await run_live(runtime=runtime, xray_url="http://test.local")

    # Driver failure is reported to the server via PATCH before re-raising.
    assert patch.called
    body = json.loads(bytes(patch.calls.last.request.content).decode())
    assert body["failure_reason"] == "agent_not_joined"
    assert body["lifecycle_state"] == "failed"
    assert runtime.closed is True


@pytest.mark.asyncio
async def test_run_live_no_audio_captured_raises_audio_missing():
    # Runtime returns no mixdown (zero frames captured). run_live must NOT
    # POST /analyze on the still-`pending` replay (that yields an opaque 409);
    # it raises a clear AudioMissingError and PATCHes the failure instead.
    replay_id = "00000000-0000-0000-0000-0000000live5"
    # assert_all_called=False: the analyze route is registered only to prove it
    # is NOT hit, so respx must not require every route to be called.
    with respx.mock(base_url="http://test.local", assert_all_called=False) as mock:
        mock.post("/v1/conversations").mock(return_value=httpx.Response(200, json={"hash": _HASH}))
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        patch = mock.patch(f"/v1/replays/{replay_id}").mock(
            return_value=httpx.Response(200, json={})
        )
        analyze = mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j", "lifecycle_state": "analyzing"})
        )

        with pytest.raises(AudioMissingError):
            await run_live(
                runtime=StubLiveRuntime(full_audio_path=None), xray_url="http://test.local"
            )

    assert patch.called
    assert not analyze.called  # never analyze an empty replay
    body = json.loads(bytes(patch.calls.last.request.content).decode())
    assert body["failure_reason"] == "audio_missing"


@pytest.mark.asyncio
async def test_run_live_server_chain_failure_raises(tmp_path: Path):
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-0000000live4"

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(return_value=httpx.Response(200, json={"hash": _HASH}))
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j", "lifecycle_state": "analyzing"})
        )
        mock.get(f"/v1/replays/{replay_id}/events").mock(
            return_value=httpx.Response(
                200,
                content=_sse([("failed", {"reason": "transcription_failed"})]),
                headers={"content-type": "text/event-stream"},
            )
        )

        with pytest.raises(ReplayEvaluationError) as exc:
            await run_live(
                runtime=StubLiveRuntime(full_audio_path=str(wav)), xray_url="http://test.local"
            )
    assert exc.value.failure_reason == "transcription_failed"
