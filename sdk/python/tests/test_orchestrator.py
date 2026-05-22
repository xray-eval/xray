"""Smoke test for the orchestrator using a stubbed runtime and respx-mocked
xray endpoints. Verifies the request shape we send to xray + the order of
the SDK's lifecycle calls."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx
from typing_extensions import override

from xray import Conversation, Turn, run
from xray.conversation import AgentResponse, RecordedAudio, TtsAudio
from xray.errors import AgentNotJoinedError, AudioMissingError, XrayServerError
from xray.orchestrator import MAX_AUDIO_BYTES
from xray.runtime.base import Runtime, RuntimeResult

_HASH_PLACEHOLDER = "a" * 64


def _raw_body(route: respx.Route, idx: int = 0) -> bytes:
    """Walk respx's loosely-typed ``Call.request.content`` -> ``bytes``."""
    call: object = route.calls[idx]
    request: object = getattr(call, "request", None)
    content: object = getattr(request, "content", None)
    if not isinstance(content, bytes):
        raise AssertionError(f"unexpected request content type: {type(content).__name__}")
    return content


def _decoded_body(route: respx.Route, idx: int = 0) -> str:
    return _raw_body(route, idx).decode()


def _request_headers(route: respx.Route, idx: int = 0) -> dict[str, str]:
    call: object = route.calls[idx]
    request: object = getattr(call, "request", None)
    headers: object = getattr(request, "headers", None)
    if not isinstance(headers, httpx.Headers):
        raise AssertionError(f"unexpected request headers type: {type(headers).__name__}")
    return dict(headers)


def _replay_response(replay_id: str) -> dict[str, object]:
    return {
        "id": replay_id,
        "conversation_hash": _HASH_PLACEHOLDER,
        "lifecycle_state": "pending",
        "analysis_step": None,
        "failure_reason": None,
        "started_at": "2026-05-18T12:00:00.000Z",
        "finished_at": None,
        "audio_path": None,
        "job_id": None,
        "run_config": None,
        "turns": [],
        "speech_segments": [],
        "tool_calls": [],
        "model_usage": [],
        "spans": [],
    }


def _conversation_upsert_response(conversation_hash: str = _HASH_PLACEHOLDER) -> dict[str, object]:
    return {
        "hash": conversation_hash,
        "name": "test-conv",
        "created_at": "2026-05-18T12:00:00.000Z",
        "last_run_at": "2026-05-18T12:00:00.000Z",
        "turns": [],
    }


class StubRuntime(Runtime):
    """Returns canned agent responses without touching LiveKit."""

    def __init__(
        self,
        responses: list[AgentResponse],
        *,
        full_audio_path: str | None = None,
    ) -> None:
        self.responses = responses
        self.full_audio_path = full_audio_path
        self.bound: dict[str, str] | None = None
        self.closed = False

    def bind(self, *, replay_id: str, conversation_hash: str) -> None:
        self.bound = {"replay_id": replay_id, "conversation_hash": conversation_hash}

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        return RuntimeResult(responses=self.responses, full_audio_path=self.full_audio_path)

    @override
    async def aclose(self) -> None:
        self.closed = True


@respx.mock
async def test_run_posts_replay_then_patches_with_status():
    conv = Conversation(
        name="alpha",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(
                key="a0",
                assertion=lambda agent: "confirmed" in agent.transcript,
                assertion_name="confirms",
            ),
        ],
    )
    runtime = StubRuntime(
        responses=[
            AgentResponse(transcript=""),
            AgentResponse(transcript="confirmed at 7pm"),
        ]
    )

    replay_id = "00000000-0000-0000-0000-000000000001"
    post_conv = respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    post_replay = respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    patch_replay = respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")

    assert post_conv.called
    # POST /v1/conversations is multipart/form-data carrying a `spec` JSON part.
    conv_headers = _request_headers(post_conv)
    assert conv_headers["content-type"].startswith("multipart/form-data")
    conv_body = _decoded_body(post_conv)
    assert 'name="spec"' in conv_body
    assert '"name":"alpha"' in conv_body
    assert '"turns":[' in conv_body
    # The SDK does NO hashing — `hash`/`sha256` never appear in the spec.
    assert '"hash"' not in conv_body
    assert '"sha256"' not in conv_body

    assert post_replay.called
    # POST /v1/replays is JSON-only and only references the conversation hash.
    replay_headers = _request_headers(post_replay)
    assert replay_headers["content-type"].startswith("application/json")

    assert patch_replay.called
    patch_body = _decoded_body(patch_replay)
    assert '"lifecycle_state":"completed"' in patch_body

    assert result.status == "completed"
    assert result.conversation_hash == _HASH_PLACEHOLDER
    assert result.name == "alpha"
    assert len(result.assertions) == 1
    assert result.assertions[0].status == "passed"

    assert runtime.bound is not None
    assert runtime.bound["replay_id"] == replay_id
    assert runtime.bound["conversation_hash"] == _HASH_PLACEHOLDER
    assert runtime.closed is True


@respx.mock
async def test_run_marks_failed_when_runtime_raises():
    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])

    class BoomRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise AgentNotJoinedError("room-x", 5.0)

        @override
        async def aclose(self) -> None: ...

    replay_id = "00000000-0000-0000-0000-0000000000ff"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    patch_replay = respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=BoomRuntime(), xray_url="http://xray.local")
    assert result.status == "failed"
    assert patch_replay.called
    body = _decoded_body(patch_replay)
    assert '"lifecycle_state":"failed"' in body
    assert '"failure_reason":"agent_not_joined"' in body


@respx.mock
async def test_run_falls_back_to_driver_aborted_for_unmapped_exception():
    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])

    class BoomRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise RuntimeError("connection refused to wss://livekit.example")

        @override
        async def aclose(self) -> None: ...

    replay_id = "00000000-0000-0000-0000-0000000000ee"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    patch_replay = respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    await run(conversation=conv, runtime=BoomRuntime(), xray_url="http://xray.local")
    body = _decoded_body(patch_replay)
    assert '"failure_reason":"driver_aborted"' in body


@pytest.mark.parametrize("passes,expected", [(True, "passed"), (False, "failed")])
@respx.mock
async def test_assertion_outcomes(passes: bool, expected: str) -> None:
    conv = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(key="a0", assertion=lambda agent: passes, assertion_name="n"),
        ],
    )
    runtime = StubRuntime(responses=[AgentResponse(transcript=""), AgentResponse(transcript="ok")])
    replay_id = "00000000-0000-0000-0000-0000000000aa"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.assertions[0].status == expected


@respx.mock
async def test_audio_uploaded_when_runtime_returns_full_audio_path(tmp_path: Path):
    wav = tmp_path / "rep.wav"
    wav_bytes = b"RIFF\0\0\0\0WAVEfmt ...."
    wav.write_bytes(wav_bytes)

    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(
        responses=[AgentResponse(transcript="")],
        full_audio_path=str(wav),
    )

    replay_id = "00000000-0000-0000-0000-0000000000bb"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    audio_upload = respx.post(f"http://xray.local/v1/replays/{replay_id}/audio").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert audio_upload.called
    headers = _request_headers(audio_upload)
    assert headers["content-type"] == "audio/wav"
    assert _raw_body(audio_upload) == wav_bytes
    assert result.status == "completed"


@respx.mock
async def test_audio_upload_skipped_when_runtime_returns_no_path():
    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(responses=[AgentResponse(transcript="")])

    replay_id = "00000000-0000-0000-0000-0000000000cc"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    audio_upload = respx.post(f"http://xray.local/v1/replays/{replay_id}/audio").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert not audio_upload.called


@respx.mock
async def test_audio_upload_failure_demotes_replay_to_failed(tmp_path: Path):
    wav = tmp_path / "rep.wav"
    wav.write_bytes(b"RIFF\0\0\0\0WAVE")

    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(
        responses=[AgentResponse(transcript="")],
        full_audio_path=str(wav),
    )

    replay_id = "00000000-0000-0000-0000-0000000000dd"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    respx.post(f"http://xray.local/v1/replays/{replay_id}/audio").mock(
        return_value=httpx.Response(500, json={"error": "store_failure"})
    )
    patch_replay = respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.status == "failed"
    body = _decoded_body(patch_replay)
    assert '"lifecycle_state":"failed"' in body


@respx.mock
async def test_run_raises_audio_missing_before_creating_replay(tmp_path: Path):
    """Pre-flight catches missing recorded audio before the Replay row is created."""
    missing = tmp_path / "nope.wav"
    conv = Conversation(
        name="x",
        turns=[Turn.user("hi", key="u0", audio=RecordedAudio(path=str(missing)))],
    )

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )

    post_replay = respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response("should-never-be-called"))
    )

    class _UnusedRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise AssertionError("runtime must not run when pre-flight fails")

        @override
        async def aclose(self) -> None:
            return None

    with pytest.raises(AudioMissingError) as exc_info:
        await run(conversation=conv, runtime=_UnusedRuntime(), xray_url="http://xray.local")

    assert exc_info.value.turn_idx == 0
    assert str(missing) in str(exc_info.value)
    assert not post_replay.called


@respx.mock
async def test_audio_upload_rejects_oversize_mixdown_locally(tmp_path: Path):
    """Pre-flight cap fires before the wire — saves the server a 50 MiB POST
    it would reject anyway, surfaces a typed AudioTooLargeError to the dev."""
    wav = tmp_path / "huge.wav"
    wav.write_bytes(b"\x00" * (MAX_AUDIO_BYTES + 1))

    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(
        responses=[AgentResponse(transcript="")],
        full_audio_path=str(wav),
    )

    replay_id = "00000000-0000-0000-0000-0000000000a1"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    audio_upload = respx.post(f"http://xray.local/v1/replays/{replay_id}/audio").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    patch_replay = respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert not audio_upload.called
    assert patch_replay.called
    assert result.status == "failed"
    body = _decoded_body(patch_replay)
    assert '"failure_reason":"driver_aborted"' in body


@respx.mock
async def test_run_raises_xray_server_error_on_post_replay_failure():
    """A non-2xx on POST /v1/replays is wrapped in a typed XrayServerError
    instead of leaking httpx.HTTPStatusError to the dev."""
    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(500, text="server exploded")
    )

    class _UnusedRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise AssertionError("runtime must not run when the POST fails")

        @override
        async def aclose(self) -> None:
            return None

    with pytest.raises(XrayServerError) as exc_info:
        await run(conversation=conv, runtime=_UnusedRuntime(), xray_url="http://xray.local")
    assert exc_info.value.status_code == 500
    assert "POST /v1/replays failed" in str(exc_info.value)


@respx.mock
async def test_run_tolerates_409_on_final_patch():
    """When the final PATCH returns 409 (server already owns the lifecycle —
    e.g. analyze worker stamped the row terminal before the SDK's PATCH landed),
    the orchestrator must NOT raise. The server's lifecycle wins; the SDK logs
    and returns a normal RunResult with its own evaluated status."""
    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(responses=[AgentResponse(transcript="ok")])

    replay_id = "00000000-0000-0000-0000-000000000409"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    patch_replay = respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(
            409,
            json={"error": "replay_lifecycle_transition", "from": "analyzing", "to": "completed"},
        )
    )

    # Must not raise — 409 on the final PATCH is tolerated, not fatal.
    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")

    assert patch_replay.called
    # SDK-side outcome reflects what the runtime + assertions produced; the
    # server's final-state divergence is logged, not surfaced as a failure.
    assert result.status == "completed"
    assert result.id == replay_id


@respx.mock
async def test_run_raises_xray_server_error_on_non_409_patch_failure():
    """A 500 (or any non-409 non-2xx) on the final PATCH must still surface as
    a typed XrayServerError — 409 is the only tolerated status."""
    conv = Conversation(name="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(responses=[AgentResponse(transcript="ok")])

    replay_id = "00000000-0000-0000-0000-0000000005ff"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(500, text="patch exploded")
    )

    with pytest.raises(XrayServerError) as exc_info:
        await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert exc_info.value.status_code == 500


@respx.mock
async def test_run_skips_pre_flight_for_tts_audio_refs():
    conv = Conversation(
        name="x",
        turns=[Turn.user("hi", key="u0", audio=TtsAudio())],
    )

    replay_id = "00000000-0000-0000-0000-000000000456"
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=_conversation_upsert_response())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json=_replay_response(replay_id))
    )
    respx.patch(f"http://xray.local/v1/replays/{replay_id}").mock(
        return_value=httpx.Response(200, json={})
    )

    runtime = StubRuntime(responses=[AgentResponse(transcript="")])
    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.status == "completed"
