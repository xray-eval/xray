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
from xray.conversation import AgentResponse, JudgeOutcome, RecordedAudio, TtsAudio
from xray.errors import AgentNotJoinedError, AudioMissingError, VersionFingerprintMismatchError
from xray.runtime.base import Runtime, RuntimeResult


def _raw_body(route: respx.Route, idx: int = 0) -> bytes:
    """Walk respx's loosely-typed ``Call.request.content`` -> ``bytes``.

    ``respx.CallList`` subclasses ``unittest.mock.NonCallableMock``, so
    every attribute on it surfaces as ``Unknown`` to pyright. One typed
    helper narrows the chain once; the tests stay readable."""
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

    def bind(self, *, replay_id: str, conversation_id: str, conversation_version: str) -> None:
        self.bound = {
            "replay_id": replay_id,
            "conversation_id": conversation_id,
            "conversation_version": conversation_version,
        }

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        return RuntimeResult(responses=self.responses, full_audio_path=self.full_audio_path)

    @override
    async def aclose(self) -> None:
        self.closed = True


@respx.mock
async def test_run_creates_conversation_then_replay_then_patches_with_judge():
    conv = Conversation(
        id="alpha",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(
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
                "conversation_id": conv.id,
                "conversation_version": conv.version,
                "status": "running",
                "failure_reason": None,
                "modality": "voice",
                "started_at": "2026-05-18T12:00:00.000Z",
                "finished_at": None,
                "audio_path": None,
                "transcript": None,
                "run_config": None,
                "judge": {"status": None, "score": None, "reason": None, "error": None},
                "turns": [],
                "assertions": [],
                "tool_calls": [],
                "model_usage": [],
                "spans": [],
            },
        )
    )
    patch_replay = respx.patch(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-000000000001"
    ).mock(return_value=httpx.Response(200, json={}))

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")

    assert post_conv.called
    assert post_replay.called
    assert patch_replay.called

    body = _decoded_body(patch_replay)
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
async def test_run_marks_failed_when_runtime_raises():
    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])

    class BoomRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise AgentNotJoinedError("room-x", 5.0)

        @override
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

    result = await run(conversation=conv, runtime=BoomRuntime(), xray_url="http://xray.local")
    assert result.status == "failed"
    assert patch_replay.called
    body = _decoded_body(patch_replay)
    assert '"status":"failed"' in body
    # Typed XrayError surfaces its `failure_reason` directly — no
    # substring matching, no message parsing.
    assert '"failure_reason":"agent_not_joined"' in body


@respx.mock
async def test_run_falls_back_to_runtime_error_for_unmapped_exception():
    """A free-form exception message that isn't in the failure_reason picklist
    is classified as `runtime_error`, not echoed verbatim — otherwise the
    server would reject the PATCH for an invalid failure_reason."""
    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])

    class BoomRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:
            raise RuntimeError("connection refused to wss://livekit.example")

        @override
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

    await run(conversation=conv, runtime=BoomRuntime(), xray_url="http://xray.local")
    body = _decoded_body(patch_replay)
    assert '"failure_reason":"runtime_error"' in body


@pytest.mark.parametrize(
    "passes,expected",
    [(True, "passed"), (False, "failed")],
)
@respx.mock
async def test_assertion_outcomes(passes: bool, expected: str) -> None:
    conv = Conversation(
        id="x",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(key="a0", assertion=lambda agent: passes, assertion_name="n"),
        ],
    )
    runtime = StubRuntime(responses=[AgentResponse(transcript=""), AgentResponse(transcript="ok")])
    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000aa"})
    )
    respx.patch("http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000aa").mock(
        return_value=httpx.Response(200, json={})
    )

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.assertions[0].status == expected


@respx.mock
async def test_audio_uploaded_when_runtime_returns_full_audio_path(tmp_path: Path):
    """When the runtime hands back a mixdown WAV, the orchestrator POSTs
    its bytes to /v1/replays/:id/audio with the audio/wav content type."""
    wav = tmp_path / "rep.wav"
    wav_bytes = b"RIFF\0\0\0\0WAVEfmt ...."  # any bytes — server validates format
    wav.write_bytes(wav_bytes)

    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(
        responses=[AgentResponse(transcript="")],
        full_audio_path=str(wav),
    )

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000bb"})
    )
    audio_upload = respx.post(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000bb/audio"
    ).mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.patch("http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000bb").mock(
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
    """No full_audio_path on RuntimeResult ⇒ no POST to .../audio."""
    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(responses=[AgentResponse(transcript="")])

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000cc"})
    )
    audio_upload = respx.post(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000cc/audio"
    ).mock(return_value=httpx.Response(200, json={"ok": True}))
    respx.patch("http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000cc").mock(
        return_value=httpx.Response(200, json={})
    )

    await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert not audio_upload.called


@respx.mock
async def test_audio_upload_failure_demotes_replay_to_failed(tmp_path: Path):
    """A 500 from the audio endpoint should mark the replay failed rather
    than silently losing the row."""
    wav = tmp_path / "rep.wav"
    wav.write_bytes(b"RIFF\0\0\0\0WAVE")

    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(
        responses=[AgentResponse(transcript="")],
        full_audio_path=str(wav),
    )

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000dd"})
    )
    respx.post("http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000dd/audio").mock(
        return_value=httpx.Response(500, json={"error": "store_failure"})
    )
    patch_replay = respx.patch(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000dd"
    ).mock(return_value=httpx.Response(200, json={}))

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.status == "failed"
    body = _decoded_body(patch_replay)
    assert '"status":"failed"' in body


@respx.mock
async def test_audio_upload_caps_at_50mib_locally(tmp_path: Path):
    """Bytes over MAX_AUDIO_BYTES are rejected before they hit the wire,
    so devs see a typed error instead of waiting on a 413 from the server.
    """
    from xray.errors import AudioTooLargeError
    from xray.orchestrator import MAX_AUDIO_BYTES

    wav = tmp_path / "huge.wav"
    wav.write_bytes(b"\0" * (MAX_AUDIO_BYTES + 1))

    conv = Conversation(id="x", turns=[Turn.user("hi", key="u0")])
    runtime = StubRuntime(
        responses=[AgentResponse(transcript="")],
        full_audio_path=str(wav),
    )

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-0000000000ee"})
    )
    audio_upload = respx.post(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000ee/audio"
    ).mock(return_value=httpx.Response(200, json={"ok": True}))
    patch_replay = respx.patch(
        "http://xray.local/v1/replays/00000000-0000-0000-0000-0000000000ee"
    ).mock(return_value=httpx.Response(200, json={}))

    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert not audio_upload.called
    assert result.status == "failed"
    body = _decoded_body(patch_replay)
    assert '"failure_reason":"runtime_error"' in body
    # Sanity: the typed error class is still importable for SDK users
    # who catch it explicitly.
    assert AudioTooLargeError.__name__ == "AudioTooLargeError"


@respx.mock
async def test_run_raises_typed_error_on_409_conversation_conflict():
    """Server's 409 on POST /v1/conversations must surface as a typed
    Python error, not as a generic httpx.HTTPStatusError."""
    conv = Conversation(id="conv-A", turns=[Turn.user("hi", key="u0")])

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(
            409,
            json={
                "error": "version_fingerprint_mismatch",
                "conversation_id": conv.id,
                "conversation_version": conv.version,
            },
        )
    )
    post_replay = respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "should-never-be-called"})
    )

    class _UnusedRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:  # pragma: no cover
            raise AssertionError("runtime must not run when 409 fires")

        @override
        async def aclose(self) -> None:  # pragma: no cover
            return None

    with pytest.raises(VersionFingerprintMismatchError) as exc_info:
        await run(conversation=conv, runtime=_UnusedRuntime(), xray_url="http://xray.local")

    assert exc_info.value.conversation_id == conv.id
    assert exc_info.value.version == conv.version
    assert not post_replay.called


@respx.mock
async def test_run_raises_audio_missing_before_creating_replay(tmp_path: Path):
    """Pre-flight catches missing recorded audio before the Replay row is created."""
    missing = tmp_path / "nope.wav"
    conv = Conversation(
        id="x",
        turns=[
            Turn.user("hi", key="u0", audio=RecordedAudio(path=str(missing))),
        ],
    )

    post_conv = respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    post_replay = respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "should-never-be-called"})
    )

    class _UnusedRuntime(Runtime):
        @override
        async def run(self, conversation: Conversation) -> RuntimeResult:  # pragma: no cover
            raise AssertionError("runtime must not run when pre-flight fails")

        @override
        async def aclose(self) -> None:  # pragma: no cover
            return None

    with pytest.raises(AudioMissingError) as exc_info:
        await run(conversation=conv, runtime=_UnusedRuntime(), xray_url="http://xray.local")

    assert exc_info.value.turn_idx == 0
    assert str(missing) in str(exc_info.value)
    assert post_conv.called
    assert not post_replay.called


@respx.mock
async def test_run_skips_pre_flight_for_tts_audio_refs():
    """TtsAudio refs don't carry a path — the runtime synths and caches.
    Pre-flight must not falsely complain."""
    conv = Conversation(
        id="x",
        turns=[Turn.user("hi", key="u0", audio=TtsAudio())],
    )

    respx.post("http://xray.local/v1/conversations").mock(
        return_value=httpx.Response(200, json=conv.to_spec_payload())
    )
    respx.post("http://xray.local/v1/replays").mock(
        return_value=httpx.Response(201, json={"id": "00000000-0000-0000-0000-000000000456"})
    )
    respx.patch("http://xray.local/v1/replays/00000000-0000-0000-0000-000000000456").mock(
        return_value=httpx.Response(200, json={})
    )

    runtime = StubRuntime(responses=[AgentResponse(transcript="")])
    result = await run(conversation=conv, runtime=runtime, xray_url="http://xray.local")
    assert result.status == "completed"
