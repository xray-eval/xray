"""``xray.run(...)`` — convenience orchestrator.

The SDK is a data collector. The server runs assertions + judges and
ships the verdict back over SSE. This function:

1. POST the Conversation (multipart: ``spec`` JSON + one file part per
   ``RecordedAudio`` turn). Server hashes the canonical spec (with
   sha256 of each WAV's bytes substituted in) and returns
   ``conversation_hash``.
2. POST the Replay referencing ``conversation_hash``. Server returns
   ``replay_id``.
3. Bind the runtime + wire the driver-side OTEL pipeline.
4. Run the runtime.
5. Upload the runtime's mixdown WAV.
6. Kick off the server-side analyze chain (POST /analyze).
7. Stream `/v1/replays/:id/events`, wait for `evaluation_complete`
   (chain success) or `failed` (chain crashed).
8. Translate the SSE payload into :class:`xray.ReplayResult` and return.

Failure model:

- Per-assertion / per-judge failures don't raise. ``result.passed``
  reflects the aggregate; pytest tests do
  ``assert result.passed, format_failures(result)``.
- Driver-side failures (runtime, mixdown, upload) PATCH the replay row
  with the appropriate ``failure_reason`` and raise the typed
  :class:`xray.XrayError`.
- Server-side chain failures (`transcription_failed`, `metrics_failed`,
  `evaluation_failed`) raise :class:`xray.ReplayEvaluationError` so
  pytest sees the test as broken, not failing.
"""

from __future__ import annotations

import asyncio
import contextvars
import io
import json
import logging
import signal
import wave
from collections.abc import Generator
from contextlib import ExitStack, contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, TypeAlias, TypedDict, TypeVar

import httpx
from opentelemetry import context as otel_context
from opentelemetry.context.context import Context
from opentelemetry.sdk.trace import TracerProvider
from pydantic import BaseModel, Field, ValidationError
from typing_extensions import NotRequired, assert_never

from xray._json import JsonObject
from xray.config import RunConfig
from xray.conversation import (
    AssertionOutcome,
    Conversation,
    EvaluationStatus,
    JudgeOutcome,
    RecordedAudio,
    ReplayResult,
    Role,
    TurnMetrics,
)
from xray.errors import (
    FAILURE_REASONS,
    AudioMissingError,
    AudioTooLargeError,
    FailureReason,
    ReplayEvaluationError,
    XrayError,
    XrayServerError,
)
from xray.otel import attach_replay_baggage
from xray.otel import install as install_otel
from xray.runtime.base import (
    Runtime,
    RuntimeBindable,
    RuntimeResult,
    StoppableRuntime,
    UserAudioInjectable,
)

logger = logging.getLogger(__name__)

# Mirrors MAX_AUDIO_BYTES in src/server/audio/audio.types.ts. The server
# enforces the cap independently; we surface a typed error before sending
# bytes the server will reject anyway.
MAX_AUDIO_BYTES = 50 * 1024 * 1024

ReplayLifecycleState: TypeAlias = Literal[
    "pending", "running", "recording_uploaded", "analyzing", "completed", "failed"
]

# ─── Wire payloads (snake_case) ───────────────────────────────────────


class ReplayCreateBody(TypedDict):
    """Body of ``POST /v1/replays``."""

    conversation_hash: str
    run_config: NotRequired[JsonObject]


class _ConversationUpsertResponse(BaseModel):
    hash: str


class _ReplayCreateResponse(BaseModel):
    id: str


class ReplayPatchBody(TypedDict):
    """PATCH /v1/replays/:id body. Mirrors the server's
    ``UpdateReplayRequestSchema``: every field is optional and the server
    rejects updates that don't change at least one column."""

    lifecycle_state: NotRequired[ReplayLifecycleState]
    failure_reason: NotRequired[FailureReason]


# ─── Public entrypoint ────────────────────────────────────────────────


async def run(
    *,
    conversation: Conversation,
    runtime: Runtime,
    xray_url: str = "http://localhost:8080",
    run_config: RunConfig | None = None,
) -> ReplayResult:
    """Drive one Replay end-to-end. Returns the server-evaluated
    :class:`ReplayResult` (which carries ``passed`` + per-assertion and
    per-judge outcomes).

    Async — wrap in ``asyncio.run`` if you need a sync entry; the
    implicit ``asyncio.run`` collided with already-running event loops
    (pytest-asyncio, Jupyter, LiveKit Agents).
    """
    xray_url = xray_url.rstrip("/")
    async with httpx.AsyncClient(base_url=xray_url, timeout=30.0) as client:
        _check_recorded_audio_exists(conversation)

        # 1. Upsert Conversation (multipart). Server hashes the canonical
        # spec (turns + judges; per-turn assertions; with sha256 of each
        # RecordedAudio's bytes substituted) and returns the hash.
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
            _raise_for_status_typed(r, "POST /v1/conversations")
        conversation_upsert = _read_response(
            r.json(), _ConversationUpsertResponse, "POST /v1/conversations"
        )
        conversation_hash = conversation_upsert.hash

        # 1b. Prefetch every user turn's audio (server-synthesized tts or
        # the recorded WAV the upsert just stored) BEFORE creating the
        # Replay row — a prefetch failure aborts cleanly with no orphan
        # `pending` replay to garbage-collect.
        user_audio = await _prefetch_user_audio(
            client=client, conversation=conversation, conversation_hash=conversation_hash
        )

        # 2. Create Replay eagerly so the runtime can propagate the id
        # via OTEL baggage BEFORE the dev's agent emits its first span.
        create_body: ReplayCreateBody = {"conversation_hash": conversation_hash}
        if run_config is not None:
            create_body["run_config"] = run_config.to_wire()
        r = await client.post("/v1/replays", json=create_body)
        _raise_for_status_typed(r, "POST /v1/replays")
        replay_create = _read_response(r.json(), _ReplayCreateResponse, "POST /v1/replays")
        replay_id = replay_create.id

        # 3-8: bind, run, upload, analyze, wait. Shared with run_live so a
        # fix to the driver-side flow (SIGINT trapping, error wrapping,
        # SSE-wait) doesn't have to land twice.
        return await _drive_replay(
            client=client,
            xray_url=xray_url,
            conversation=conversation,
            conversation_hash=conversation_hash,
            replay_id=replay_id,
            runtime=runtime,
            user_audio=user_audio,
        )


async def run_live(
    *,
    runtime: Runtime,
    xray_url: str = "http://localhost:8080",
    name: str | None = None,
    run_config: RunConfig | None = None,
) -> ReplayResult:
    """Drive one *live* mic session end-to-end and return its
    :class:`ReplayResult`.

    Unlike :func:`run`, there is no authored ``Conversation`` — the user
    talks to their agent in real time. This:

    1. Upserts a fresh ``live`` Conversation (empty turns; the server salts
       the hash so each session is its own row). ``name`` defaults to
       ``live-<ISO-8601 UTC>``.
    2. Creates the Replay and binds it onto the runtime + OTEL baggage so
       the agent's spans attribute correctly.
    3. Runs the runtime until the user stops it (SIGINT → the runtime's
       ``request_stop`` when it implements :class:`StoppableRuntime`).
    4. Uploads the stereo mixdown, kicks off the analyze chain, waits for
       the server's ``evaluation_complete`` SSE.

    The returned :class:`ReplayResult` carries empty ``assertions`` /
    ``judges`` (a live session declares none) and ``passed=True``; its
    ``metrics`` still hold the server's VAD-derived per-turn timings. Driver
    or server-chain failures raise the same typed errors as :func:`run`.
    """
    xray_url = xray_url.rstrip("/")
    conv_name = name or f"live-{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    conversation = Conversation(name=conv_name, turns=[], live=True)

    async with httpx.AsyncClient(base_url=xray_url, timeout=30.0) as client:
        # 1. Upsert the live Conversation (multipart, spec part only — a live
        # session references no recorded-audio file parts).
        spec = conversation.to_conversation_spec_payload()
        files: list[tuple[str, tuple[str | None, str, str]]] = [
            ("spec", (None, json.dumps(spec, separators=(",", ":")), "application/json")),
        ]
        r = await client.post("/v1/conversations", files=files)
        _raise_for_status_typed(r, "POST /v1/conversations")
        conversation_hash = _read_response(
            r.json(), _ConversationUpsertResponse, "POST /v1/conversations"
        ).hash

        # 2. Create the Replay eagerly so the runtime can propagate the id.
        create_body: ReplayCreateBody = {"conversation_hash": conversation_hash}
        if run_config is not None:
            create_body["run_config"] = run_config.to_wire()
        r = await client.post("/v1/replays", json=create_body)
        _raise_for_status_typed(r, "POST /v1/replays")
        replay_id = _read_response(r.json(), _ReplayCreateResponse, "POST /v1/replays").id

        # 3-8: bind, run, upload, analyze, wait. Same shared driver as
        # `run`, with SIGINT routing enabled (Ctrl+C ends the open-ended
        # session) and the no-audio guard active (a session that captured
        # zero frames fails with AudioMissingError instead of POSTing
        # /analyze on a still-`pending` replay).
        return await _drive_replay(
            client=client,
            xray_url=xray_url,
            conversation=conversation,
            conversation_hash=conversation_hash,
            replay_id=replay_id,
            runtime=runtime,
            sigint_routing=True,
            require_audio=True,
        )


async def _drive_replay(
    *,
    client: httpx.AsyncClient,
    xray_url: str,
    conversation: Conversation,
    conversation_hash: str,
    replay_id: str,
    runtime: Runtime,
    sigint_routing: bool = False,
    require_audio: bool = False,
    user_audio: dict[int, bytes] | None = None,
) -> ReplayResult:
    """Steps 3-8 of the orchestrator: bind the runtime, install the OTEL
    pipeline, run, upload the mixdown, kick off /analyze, wait for the
    terminal SSE event.

    Shared between :func:`run` and :func:`run_live` — the conversation
    upsert + replay create (steps 1-2) differ between the two entrypoints
    but everything past the replay id is identical. ``sigint_routing=True``
    wires SIGINT → :meth:`StoppableRuntime.request_stop` for the duration
    of the runtime run (live mode). ``require_audio=True`` raises
    :class:`AudioMissingError` when the runtime returned no mixdown
    (live mode — protects against POSTing /analyze on a still-`pending`
    replay, which the server rejects with an opaque 409).
    """
    if isinstance(runtime, RuntimeBindable):
        runtime.bind(replay_id=replay_id, conversation_hash=conversation_hash)
    if user_audio is not None and isinstance(runtime, UserAudioInjectable):
        runtime.inject_user_audio(user_audio)
    tracer_provider: TracerProvider = install_otel(endpoint=xray_url)
    baggage_token: contextvars.Token[Context] = attach_replay_baggage(
        replay_id=replay_id,
        conversation_hash=conversation_hash,
        modality="voice",
    )

    # We capture the typed XrayError instance (not just its
    # `failure_reason`) so we can re-raise the SAME subclass after the
    # PATCH below — the dev's `except AgentNotJoinedError` /
    # `except AudioMissingError` block has to fire, not a bare base
    # XrayError. Untyped runtime exceptions become a fresh
    # `XrayError(failure_reason='driver_aborted')`.
    driver_error: XrayError | None = None
    runtime_result: RuntimeResult | None = None
    sigint_cm = _sigint_stops(runtime) if sigint_routing else nullcontext()
    with sigint_cm:
        try:
            runtime_result = await runtime.run(conversation)
        except XrayError as e:
            logger.exception("typed runtime failure on replay %s", replay_id)
            driver_error = e
        except Exception as e:
            logger.exception("unclassified runtime failure on replay %s", replay_id)
            driver_error = XrayError(f"runtime failed: {e}")
        finally:
            await runtime.aclose()
            # Flush driver-side spans + detach baggage before /analyze so
            # any in-flight ``xray.turn`` exports land in xray first.
            tracer_provider.force_flush(timeout_millis=10_000)
            otel_context.detach(baggage_token)

    if (
        driver_error is None
        and runtime_result is not None
        and runtime_result.full_audio_path is not None
    ):
        try:
            await _upload_replay_audio(
                client=client, replay_id=replay_id, audio_path=runtime_result.full_audio_path
            )
        except XrayError as e:
            logger.exception("audio upload failed on replay %s", replay_id)
            driver_error = e
        except Exception as e:
            logger.exception("audio upload errored on replay %s", replay_id)
            driver_error = XrayError(f"audio upload failed: {e}")

    if (
        require_audio
        and driver_error is None
        and (runtime_result is None or runtime_result.full_audio_path is None)
    ):
        driver_error = AudioMissingError(
            "live session captured no audio — nothing to analyze. The microphone "
            "produced no frames (check OS mic permission for your terminal/Python, and "
            "that an input device is selected), or the session ended before any audio."
        )

    if driver_error is not None:
        await _patch_driver_failure(client, replay_id, driver_error.failure_reason)
        raise driver_error

    r = await client.post(f"/v1/replays/{replay_id}/analyze")
    _raise_for_status_typed(r, f"POST /v1/replays/{replay_id}/analyze")

    # Match exhaustively on the discriminated union so adding a third
    # `_EvalOutcome` variant later statically forces every consumer to
    # handle it — `assert_never(outcome)` turns the missing arm into a
    # pyright error rather than a silent fall-through.
    outcome = await _wait_for_evaluation(client, replay_id)
    match outcome:
        case _EvalFailed(failure_reason=reason):
            raise ReplayEvaluationError(replay_id, reason)
        case _EvalCompleted(payload=payload):
            return _result_from_payload(payload, replay_id=replay_id)
        case _:
            assert_never(outcome)


@contextmanager
def _sigint_stops(runtime: Runtime) -> Generator[None, None, None]:
    """Route SIGINT to ``runtime.request_stop`` for the duration of the
    block, when the runtime is :class:`StoppableRuntime`. Prefers the
    asyncio loop's signal handler; falls back to ``signal.signal`` where
    the loop doesn't support it (e.g. the Windows Proactor loop). Restores
    the prior behavior on exit. A no-op for runtimes that aren't stoppable."""
    if not isinstance(runtime, StoppableRuntime):
        yield
        return

    stoppable = runtime
    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGINT, stoppable.request_stop)
    except (NotImplementedError, RuntimeError, ValueError):
        # The loop can't trap signals here. Three known cases land in this
        # branch: Windows Proactor (NotImplementedError), some test loops
        # (RuntimeError), and off-main-thread invocation (ValueError from
        # the underlying signal.set_wakeup_fd — e.g. `xray.run_live` called
        # from a worker thread). Fall back to a plain signal handler, which
        # itself no-ops off the main thread.
        with _signal_signal_stops(stoppable):
            yield
        return
    try:
        yield
    finally:
        loop.remove_signal_handler(signal.SIGINT)


@contextmanager
def _signal_signal_stops(stoppable: StoppableRuntime) -> Generator[None, None, None]:
    try:
        previous = signal.getsignal(signal.SIGINT)
        signal.signal(signal.SIGINT, lambda _sig, _frame: stoppable.request_stop())
    except ValueError:
        # Not the main thread — can't trap SIGINT here. The session can still
        # be stopped programmatically via runtime.request_stop().
        yield
        return
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, previous)


# ─── Result translation ──────────────────────────────────────────────


class _AssertionOutcomePayload(BaseModel):
    turn_idx: int
    assertion_idx: int
    kind: str
    status: EvaluationStatus
    message: str | None = None


class _JudgeOutcomePayload(BaseModel):
    judge_idx: int
    kind: str
    status: EvaluationStatus
    score: int | None = None
    reason: str | None = None


class _TurnMetricsPayload(BaseModel):
    turn_idx: int
    role: Role
    agent_response_ms: int | None = None
    ttft_ms: int | None = None
    interrupted: bool


class _ReplayResultMetricsPayload(BaseModel):
    turns: list[_TurnMetricsPayload] = Field(default_factory=list[_TurnMetricsPayload])


class _ReplayResultPayload(BaseModel):
    replay_id: str
    conversation_hash: str
    passed: bool
    assertions: list[_AssertionOutcomePayload] = Field(
        default_factory=list[_AssertionOutcomePayload]
    )
    judges: list[_JudgeOutcomePayload] = Field(default_factory=list[_JudgeOutcomePayload])
    metrics: _ReplayResultMetricsPayload


class _EvaluationCompleteEnvelope(BaseModel):
    """Server wire shape: ``{"type": "evaluation_complete", "result": {...}}``."""

    result: _ReplayResultPayload


def _result_from_payload(payload: _ReplayResultPayload, *, replay_id: str) -> ReplayResult:
    return ReplayResult(
        replay_id=payload.replay_id or replay_id,
        conversation_hash=payload.conversation_hash,
        passed=payload.passed,
        assertions=tuple(
            AssertionOutcome(
                turn_idx=a.turn_idx,
                assertion_idx=a.assertion_idx,
                kind=a.kind,
                status=a.status,
                message=a.message,
            )
            for a in payload.assertions
        ),
        judges=tuple(
            JudgeOutcome(
                judge_idx=j.judge_idx,
                kind=j.kind,
                status=j.status,
                score=j.score,
                reason=j.reason,
            )
            for j in payload.judges
        ),
        metrics=tuple(
            TurnMetrics(
                turn_idx=m.turn_idx,
                role=m.role,
                agent_response_ms=m.agent_response_ms,
                ttft_ms=m.ttft_ms,
                interrupted=m.interrupted,
            )
            for m in payload.metrics.turns
        ),
    )


# ─── SSE wait ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _EvalCompleted:
    kind: Literal["completed"]
    payload: _ReplayResultPayload


@dataclass(frozen=True)
class _EvalFailed:
    kind: Literal["failed"]
    failure_reason: FailureReason


_EvalOutcome: TypeAlias = _EvalCompleted | _EvalFailed


class _SseFailedData(BaseModel):
    reason: str


async def _wait_for_evaluation(
    client: httpx.AsyncClient,
    replay_id: str,
    *,
    timeout_s: float = 600.0,
) -> _EvalOutcome:
    """Stream `/v1/replays/:id/events` and return either the parsed
    `evaluation_complete` payload or the failure reason.

    Pure-stdlib SSE parser: ``event: <type>`` followed by ``data:
    <json>``, blank line terminates. Heartbeats (`:` prefix) skipped.
    """
    async with client.stream(
        "GET",
        f"/v1/replays/{replay_id}/events",
        timeout=timeout_s,
        headers={"accept": "text/event-stream"},
    ) as response:
        _raise_for_status_typed(response, f"GET /v1/replays/{replay_id}/events")
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
            if line.startswith("data:"):
                data = line[len("data:") :].strip()
                if event_type == "evaluation_complete":
                    parsed = _parse_evaluation_complete(data)
                    if parsed is not None:
                        return _EvalCompleted(kind="completed", payload=parsed)
                elif event_type == "failed":
                    # `failed` is terminal even with an unreadable body — don't
                    # wait for stream close, the server already gave up.
                    reason = _parse_failed_reason(data) or "evaluation_failed"
                    return _EvalFailed(kind="failed", failure_reason=reason)
        # Stream closed without a terminal event — treat as a server-side
        # collapse so the dev sees a clear error instead of a successful
        # null verdict.
        raise ReplayEvaluationError(replay_id, "evaluation_failed")


def _parse_evaluation_complete(raw: str) -> _ReplayResultPayload | None:
    # Server always emits the envelope shape ``{"type": ..., "result": {...}}``;
    # fall back to a bare result payload so older fixtures + manual probes
    # against the SSE stream keep working.
    try:
        return _EvaluationCompleteEnvelope.model_validate_json(raw).result
    except ValidationError:
        pass
    try:
        return _ReplayResultPayload.model_validate_json(raw)
    except ValidationError:
        logger.warning("evaluation_complete payload failed validation; ignoring")
        return None


def _parse_failed_reason(raw: str) -> FailureReason | None:
    try:
        decoded = _SseFailedData.model_validate_json(raw)
    except ValidationError:
        return None
    # Unknown reasons map to `evaluation_failed` so the dev still gets a
    # typed raise — never `None`, which would silently drop the failure.
    for member in FAILURE_REASONS:
        if decoded.reason == member:
            return member
    return "evaluation_failed"


# ─── Driver-side failure PATCH (the one remaining PATCH path) ────────


async def _patch_driver_failure(
    client: httpx.AsyncClient, replay_id: str, failure_reason: FailureReason
) -> None:
    body: ReplayPatchBody = {"lifecycle_state": "failed", "failure_reason": failure_reason}
    r = await client.patch(f"/v1/replays/{replay_id}", json=body)
    if r.status_code == 409:
        # Server beat us to it (e.g. it stamped the row from another path).
        # Server's truth wins; nothing more to do here.
        logger.info(
            "PATCH /v1/replays/%s returned 409 — server owns lifecycle, accepting its state",
            replay_id,
        )
        return
    _raise_for_status_typed(r, f"PATCH /v1/replays/{replay_id}")


# ─── Helpers ──────────────────────────────────────────────────────────


_TResponse = TypeVar("_TResponse", bound=BaseModel)


def _read_response(raw: object, model_cls: type[_TResponse], endpoint: str) -> _TResponse:
    try:
        return model_cls.model_validate(raw)
    except ValidationError as e:
        raise XrayError(f"{endpoint} response malformed: {e}") from e


def _raise_for_status_typed(response: httpx.Response, endpoint: str) -> None:
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise XrayServerError(
            f"{endpoint} failed: {e.response.status_code} {e.response.text[:500]}",
            status_code=e.response.status_code,
        ) from e


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
    _raise_for_status_typed(response, f"POST /v1/replays/{replay_id}/audio")


def _check_recorded_audio_exists(conversation: Conversation) -> None:
    for idx, turn in enumerate(conversation.turns):
        audio = turn.audio
        if not isinstance(audio, RecordedAudio):
            continue
        path = Path(audio.path)
        if not path.is_file():
            raise AudioMissingError(f"recorded audio file not found: {path}", turn_idx=idx)


# Matches the runtime's publish format (livekit.py SAMPLE_RATE et al.) and
# the server's stored-turn-audio contract: 48 kHz / mono / 16-bit.
_TURN_AUDIO_RATE = 48_000
_TURN_AUDIO_CHANNELS = 1
_TURN_AUDIO_SAMPLE_WIDTH = 2


async def _prefetch_user_audio(
    *,
    client: httpx.AsyncClient,
    conversation: Conversation,
    conversation_hash: str,
) -> dict[int, bytes]:
    """Fetch every user turn's audio from the server and decode to raw
    PCM keyed by turn idx. The server is the single audio source — the
    synthesized tts WAVs and the content-addressed recorded WAVs both
    come back through the same endpoint, so the driver publishes exactly
    the bytes the conversation hash pinned."""
    audio: dict[int, bytes] = {}
    for idx, turn in enumerate(conversation.turns):
        if turn.role != "user":
            continue
        endpoint = f"/v1/conversations/{conversation_hash}/turns/{idx}/audio"
        r = await client.get(endpoint)
        _raise_for_status_typed(r, f"GET {endpoint}")
        audio[idx] = _wav_bytes_to_pcm(r.content, turn_idx=idx)
    return audio


def _wav_bytes_to_pcm(data: bytes, *, turn_idx: int) -> bytes:
    """Decode a server-served turn WAV to raw PCM, enforcing the
    48 kHz / mono / 16-bit contract — a mismatch is a server bug we want
    pinned to the turn rather than surfacing as distorted playback."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            rate = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            pcm = w.readframes(w.getnframes())
    except (wave.Error, EOFError) as e:
        raise AudioMissingError(
            f"turn {turn_idx}: server returned an unreadable WAV: {e}", turn_idx=turn_idx
        ) from e
    if (
        rate != _TURN_AUDIO_RATE
        or channels != _TURN_AUDIO_CHANNELS
        or width != _TURN_AUDIO_SAMPLE_WIDTH
    ):
        raise AudioMissingError(
            f"turn {turn_idx}: server returned {rate} Hz / {channels} ch / {width * 8}-bit "
            f"audio, expected {_TURN_AUDIO_RATE} Hz / {_TURN_AUDIO_CHANNELS} ch / 16-bit",
            turn_idx=turn_idx,
        )
    return pcm


@contextmanager
def _open_recorded_audio_files(
    conversation: Conversation,
) -> Generator[list[tuple[str, tuple[str, io.BufferedReader, str]]], None, None]:
    """Yield an httpx ``files=`` list with each RecordedAudio opened binary."""
    with ExitStack() as stack:
        files = [
            (upload_key, (Path(p).name, stack.enter_context(Path(p).open("rb")), "audio/wav"))
            for upload_key, p in conversation.recorded_audio_uploads()
        ]
        yield files


__all__ = [
    "MAX_AUDIO_BYTES",
    "ReplayPatchBody",
    "run",
    "run_live",
]
