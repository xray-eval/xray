"""Orchestrator tests for the post-spec-0001 surface: the SDK is a data
collector, the server runs assertions + judges, the SDK reads the
verdict off the SSE `evaluation_complete` event and returns
:class:`xray.ReplayResult`."""

from __future__ import annotations

import asyncio
import io
import json
import wave
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
import respx
from typing_extensions import override

from xray import Assertion, Conversation, Judge, ReplayResult, Turn, run
from xray.conversation import AgentResponse
from xray.errors import (
    AgentNotJoinedError,
    AudioMissingError,
    ReplayEvaluationError,
    XrayError,
    XrayServerError,
)
from xray.runtime.base import Runtime, RuntimeResult

_HASH_PLACEHOLDER = "a" * 64


def _conversation_upsert_response(conversation_hash: str = _HASH_PLACEHOLDER) -> dict[str, object]:
    return {
        "hash": conversation_hash,
        "name": "test-conv",
        "created_at": "2026-05-18T12:00:00.000Z",
        "last_run_at": "2026-05-18T12:00:00.000Z",
        "turns": [],
        "judges": [],
    }


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


def _eval_complete_payload(
    *,
    replay_id: str,
    passed: bool = True,
    assertions: list[dict[str, object]] | None = None,
    judges: list[dict[str, object]] | None = None,
    turns: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "replay_id": replay_id,
        "conversation_hash": _HASH_PLACEHOLDER,
        "passed": passed,
        "assertions": assertions or [],
        "judges": judges or [],
        "metrics": {"turns": turns or []},
    }


def _sse_stream(events: Iterable[tuple[str, dict[str, object]]]) -> bytes:
    """Build a valid SSE body from `(event_type, data_object)` pairs."""
    lines: list[str] = []
    for event_type, data in events:
        lines.append(f"event: {event_type}")
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


def _mock_sse_endpoint(mock: respx.MockRouter, replay_id: str, body: bytes) -> respx.Route:
    return mock.get(f"/v1/replays/{replay_id}/events").mock(
        return_value=httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/event-stream"},
        )
    )


class StubRuntime(Runtime):
    """Returns canned agent responses without touching LiveKit."""

    def __init__(
        self,
        responses: list[AgentResponse] | None = None,
        *,
        full_audio_path: str | None = None,
        recording_started_at_epoch: float | None = None,
        raise_on_run: Exception | None = None,
    ) -> None:
        self.responses = responses or []
        self.full_audio_path = full_audio_path
        self.recording_started_at_epoch = recording_started_at_epoch
        self.raise_on_run = raise_on_run
        self.bound: dict[str, str] | None = None
        self.closed = False

    def bind(self, *, replay_id: str, conversation_hash: str) -> None:
        self.bound = {"replay_id": replay_id, "conversation_hash": conversation_hash}

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        if self.raise_on_run is not None:
            raise self.raise_on_run
        return RuntimeResult(
            responses=self.responses,
            full_audio_path=self.full_audio_path,
            recording_started_at_epoch=self.recording_started_at_epoch,
        )

    @override
    async def aclose(self) -> None:
        self.closed = True


def _wav_48k_mono(ms: int = 20) -> bytes:
    """Valid 48 kHz / mono / 16-bit WAV of silence — what the server's
    turn-audio endpoint serves and the prefetch decoder enforces."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48_000)
        w.writeframes(b"\x00\x00" * (48_000 * ms // 1000))
    return buf.getvalue()


def _mock_turn_audio(mock: respx.MockRouter) -> respx.Route:
    """Register the prefetch GET for any conversation/turn. One regex route
    instead of per-turn registrations — tests don't care which idx."""
    return mock.get(url__regex=r"/v1/conversations/[0-9a-f]{64}/turns/\d+/audio").mock(
        return_value=httpx.Response(
            200, content=_wav_48k_mono(), headers={"content-type": "audio/wav"}
        )
    )


def _make_wav(tmp_path: Path) -> Path:
    # Minimal valid bytes — server doesn't decode in unit tests, we just
    # need a file the SDK can open + send. Server-side WAV decoding is
    # covered by the integration test, not here.
    path = tmp_path / "mix.wav"
    path.write_bytes(b"RIFF" + b"\x00" * 64)
    return path


@pytest.mark.asyncio
async def test_full_chain_returns_replay_result_with_passed_true(tmp_path: Path):
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000abc"
    conversation = Conversation(
        name="books a table",
        turns=[
            Turn.user("book a table for two tonight", key="u0"),
            Turn.agent(
                key="a0",
                assertions=(Assertion.contains("confirmed"),),
            ),
        ],
        judges=(Judge.text_match("agent confirms a reservation", pass_score=70),),
    )

    with respx.mock(base_url="http://test.local") as mock:
        post_conv = mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        _mock_turn_audio(mock)
        post_replay = mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        post_audio = mock.post(f"/v1/replays/{replay_id}/audio").mock(
            return_value=httpx.Response(204)
        )
        post_analyze = mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        sse = _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "evaluation_complete",
                        {
                            "type": "evaluation_complete",
                            "result": _eval_complete_payload(
                                replay_id=replay_id,
                                passed=True,
                                assertions=[
                                    {
                                        "turn_idx": 1,
                                        "assertion_idx": 0,
                                        "kind": "contains",
                                        "status": "passed",
                                        "message": None,
                                    }
                                ],
                                judges=[
                                    {
                                        "judge_idx": 0,
                                        "kind": "text_match",
                                        "status": "passed",
                                        "score": 92,
                                        "reason": "agent confirms the booking",
                                    }
                                ],
                            ),
                        },
                    )
                ]
            ),
        )

        # Anchor: wall-clock of mixdown sample 0. Built from a known datetime
        # so the expected header string is exact, not re-derived via the
        # helper under test.
        recording_t0 = datetime(2026, 5, 26, 14, 31, 31, 23000, tzinfo=timezone.utc)
        result = await run(
            conversation=conversation,
            runtime=StubRuntime(
                full_audio_path=str(wav),
                recording_started_at_epoch=recording_t0.timestamp(),
            ),
            xray_url="http://test.local",
        )

    assert isinstance(result, ReplayResult)
    assert result.passed is True
    assert result.replay_id == replay_id
    assert len(result.assertions) == 1
    assert result.assertions[0].status == "passed"
    assert result.assertions[0].kind == "contains"
    assert len(result.judges) == 1
    assert result.judges[0].score == 92
    assert post_conv.called
    assert post_replay.called
    assert post_audio.called
    audio_request: object = getattr(post_audio.calls[0], "request", None)
    assert isinstance(audio_request, httpx.Request)
    assert audio_request.headers["x-recording-started-at"] == "2026-05-26T14:31:31.023000Z"
    assert post_analyze.called
    assert sse.called


@pytest.mark.asyncio
async def test_passed_false_when_an_assertion_fails(tmp_path: Path):
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000bbb"
    conversation = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(key="a0", assertions=(Assertion.contains("missing"),)),
        ],
    )

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        _mock_turn_audio(mock)
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "evaluation_complete",
                        {
                            "type": "evaluation_complete",
                            "result": _eval_complete_payload(
                                replay_id=replay_id,
                                passed=False,
                                assertions=[
                                    {
                                        "turn_idx": 1,
                                        "assertion_idx": 0,
                                        "kind": "contains",
                                        "status": "failed",
                                        "message": 'transcript did not contain "missing"',
                                    }
                                ],
                            ),
                        },
                    )
                ]
            ),
        )

        result = await run(
            conversation=conversation,
            runtime=StubRuntime(full_audio_path=str(wav)),
            xray_url="http://test.local",
        )

    assert result.passed is False
    assert result.assertions[0].status == "failed"
    assert result.assertions[0].message == 'transcript did not contain "missing"'


@pytest.mark.asyncio
async def test_orchestrator_does_not_fetch_enrichment_or_patch_on_success(tmp_path: Path):
    """Post spec 0001: no GET /v1/replays/:id (enrichment), no PATCH
    `lifecycle_state` (server owns it). The orchestrator's only writes are
    the upserts in steps 1–6 + the audio upload."""
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000ccc"
    conversation = Conversation(name="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        _mock_turn_audio(mock)
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "evaluation_complete",
                        {
                            "type": "evaluation_complete",
                            "result": _eval_complete_payload(replay_id=replay_id),
                        },
                    )
                ]
            ),
        )
        # respx returns 404 for any unrouted URL — assert no enrichment fetch
        # happens by NOT registering GET /v1/replays/:id and asserting the
        # run still succeeds (would 500 if the orchestrator tried to call it).
        # respx will raise on an unrouted call when assert_all_called=False
        # is the default; verify by setting it explicit and asserting no
        # passthrough.

        result = await run(
            conversation=conversation,
            runtime=StubRuntime(full_audio_path=str(wav)),
            xray_url="http://test.local",
        )

    assert result.passed is True
    # No PATCH route was registered; if the orchestrator had tried, respx
    # would have raised AllMockedAssertionError.


@pytest.mark.asyncio
async def test_server_chain_failure_raises_replay_evaluation_error(tmp_path: Path):
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000ddd"
    conversation = Conversation(name="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        _mock_turn_audio(mock)
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "failed",
                        {"type": "failed", "reason": "transcription_failed"},
                    )
                ]
            ),
        )

        with pytest.raises(ReplayEvaluationError) as exc_info:
            await run(
                conversation=conversation,
                runtime=StubRuntime(full_audio_path=str(wav)),
                xray_url="http://test.local",
            )

    assert exc_info.value.replay_id == replay_id
    assert exc_info.value.failure_reason == "transcription_failed"


@pytest.mark.asyncio
async def test_driver_runtime_typed_failure_patches_failed_and_raises():
    replay_id = "00000000-0000-0000-0000-000000000eee"
    conversation = Conversation(name="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        _mock_turn_audio(mock)
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        patch = mock.patch(f"/v1/replays/{replay_id}").mock(return_value=httpx.Response(200))

        with pytest.raises(XrayError):
            await run(
                conversation=conversation,
                runtime=StubRuntime(
                    raise_on_run=AgentNotJoinedError(room="r", timeout_s=5.0),
                ),
                xray_url="http://test.local",
            )

    assert patch.called
    call = patch.calls[0]
    request_obj: object = getattr(call, "request", None)
    content_obj: object = getattr(request_obj, "content", b"")
    assert isinstance(content_obj, bytes)
    body = json.loads(content_obj)
    assert body["lifecycle_state"] == "failed"
    assert body["failure_reason"] == "agent_not_joined"


@pytest.mark.asyncio
async def test_missing_recorded_audio_raises_before_any_http_call(tmp_path: Path):
    """RecordedAudio pointing at a non-existent file should raise
    AudioMissingError BEFORE any /v1/conversations POST — the SDK
    pre-flights the filesystem so no orphan replay row gets created."""
    from xray.conversation import RecordedAudio

    conversation = Conversation(
        name="x",
        turns=[
            Turn.user(
                "hi",
                key="u0",
                audio=RecordedAudio(path=str(tmp_path / "nope.wav")),
            )
        ],
    )

    with respx.mock(base_url="http://test.local", assert_all_called=False) as mock:
        post_conv = mock.post("/v1/conversations")

        with pytest.raises(AudioMissingError):
            await run(
                conversation=conversation,
                runtime=StubRuntime(),
                xray_url="http://test.local",
            )

    assert not post_conv.called


@pytest.mark.asyncio
async def test_conversations_post_carries_assertions_and_judges_in_spec_json(tmp_path: Path):
    """The wire shape of /v1/conversations: assertions live under each
    turn's `assertions` array; judges live at the top level. This test
    pins the wire contract so future SDK refactors can't silently drop
    them."""
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000fff"
    conversation = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(key="a0", assertions=(Assertion.contains("yes"),)),
        ],
        judges=(Judge.text_match("agent agrees"),),
    )

    with respx.mock(base_url="http://test.local") as mock:
        post_conv = mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        _mock_turn_audio(mock)
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "evaluation_complete",
                        {
                            "type": "evaluation_complete",
                            "result": _eval_complete_payload(replay_id=replay_id),
                        },
                    )
                ]
            ),
        )

        await run(
            conversation=conversation,
            runtime=StubRuntime(full_audio_path=str(wav)),
            xray_url="http://test.local",
        )

    call = post_conv.calls[0]
    request_obj: object = getattr(call, "request", None)
    content_obj: object = getattr(request_obj, "content", b"")
    assert isinstance(content_obj, bytes)
    body = content_obj.decode("latin-1")
    # The multipart body inlines the `spec` JSON as a form field. Grep for
    # both shapes — the precise multipart boundary doesn't matter for the
    # contract.
    assert '"assertions":[{"text":"yes","case_insensitive":true,"kind":"contains"}]' in body
    assert '"judges":[{"reference":"agent agrees","pass_score":70,"kind":"text_match"}]' in body


@pytest.mark.asyncio
async def test_server_error_on_conversations_post_raises_xray_server_error():
    conversation = Conversation(name="x", turns=[Turn.user("hi", key="u0")])

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(return_value=httpx.Response(500, text="boom"))

        with pytest.raises(XrayServerError):
            await run(
                conversation=conversation,
                runtime=StubRuntime(),
                xray_url="http://test.local",
            )


class _InjectableStubRuntime(StubRuntime):
    """StubRuntime + UserAudioInjectable, so the test can observe what the
    orchestrator prefetched."""

    def __init__(self, **kw: object) -> None:
        super().__init__(full_audio_path=str(kw["full_audio_path"]))
        self.injected: dict[int, bytes] | None = None

    def inject_user_audio(self, audio: dict[int, bytes]) -> None:
        self.injected = dict(audio)


@pytest.mark.asyncio
async def test_orchestrator_prefetches_user_turn_audio_and_injects_it(tmp_path: Path):
    """Every user turn's audio is GET from the server after the upsert and
    handed to the runtime before `run` — the driver never synthesizes or
    reads local files. Agent turns are not fetched."""
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000eee"
    conversation = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.agent(key="a0"),
            Turn.user("bye", key="u1"),
        ],
    )

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        audio_route = _mock_turn_audio(mock)
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "evaluation_complete",
                        {
                            "type": "evaluation_complete",
                            "result": _eval_complete_payload(replay_id=replay_id),
                        },
                    )
                ]
            ),
        )

        runtime = _InjectableStubRuntime(full_audio_path=str(wav))
        await run(conversation=conversation, runtime=runtime, xray_url="http://test.local")

    # Two user turns fetched (idx 0 and 2); the agent turn (idx 1) is not.
    # The injected key set proves which idx values were fetched — the respx
    # CallList's request chain is Unknown-typed (see pyproject pyright note),
    # so the per-URL assertion lives in the injected map instead.
    assert audio_route.call_count == 2
    assert runtime.injected is not None
    assert sorted(runtime.injected.keys()) == [0, 2]
    # 20ms of 48kHz mono int16 silence = 960 samples * 2 bytes.
    assert runtime.injected[0] == b"\x00\x00" * 960


@pytest.mark.asyncio
async def test_orchestrator_prefetches_user_turn_audio_concurrently(tmp_path: Path):
    """The per-turn audio GETs fire concurrently — a sequential await-in-loop
    would cap in-flight requests at 1 and serialize startup."""
    wav = _make_wav(tmp_path)
    replay_id = "00000000-0000-0000-0000-000000000fff"
    conversation = Conversation(
        name="x",
        turns=[
            Turn.user("a", key="u0"),
            Turn.user("b", key="u1"),
            Turn.agent(key="a0"),
            Turn.user("c", key="u2"),
        ],
    )
    in_flight = 0
    max_in_flight = 0

    async def audio_handler(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        # Yield twice so every sibling coroutine has a chance to enter before
        # any returns — under a sequential loop only one is ever in flight.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        in_flight -= 1
        return httpx.Response(200, content=_wav_48k_mono(), headers={"content-type": "audio/wav"})

    with respx.mock(base_url="http://test.local") as mock:
        mock.post("/v1/conversations").mock(
            return_value=httpx.Response(200, json=_conversation_upsert_response())
        )
        mock.get(url__regex=r"/v1/conversations/[0-9a-f]{64}/turns/\d+/audio").mock(
            side_effect=audio_handler
        )
        mock.post("/v1/replays").mock(
            return_value=httpx.Response(201, json=_replay_response(replay_id))
        )
        mock.post(f"/v1/replays/{replay_id}/audio").mock(return_value=httpx.Response(204))
        mock.post(f"/v1/replays/{replay_id}/analyze").mock(
            return_value=httpx.Response(202, json={"job_id": "j1", "lifecycle_state": "analyzing"})
        )
        _mock_sse_endpoint(
            mock,
            replay_id,
            _sse_stream(
                [
                    (
                        "evaluation_complete",
                        {
                            "type": "evaluation_complete",
                            "result": _eval_complete_payload(replay_id=replay_id),
                        },
                    )
                ]
            ),
        )

        runtime = _InjectableStubRuntime(full_audio_path=str(wav))
        await run(conversation=conversation, runtime=runtime, xray_url="http://test.local")

    assert runtime.injected is not None
    assert sorted(runtime.injected.keys()) == [0, 1, 3]
    # All 3 user turns in flight at once; the old sequential loop capped this at 1.
    assert max_in_flight == 3
