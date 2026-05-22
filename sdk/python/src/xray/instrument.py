"""``@xray.instrument`` — the single entrypoint for adding xray
observability to an existing LiveKit Agents worker.

Usage::

    import xray

    @xray.instrument(service_name="voice-service")
    async def entrypoint(ctx):
        await ctx.connect()
        async with ctx.xray.turn(0):
            ...
        ctx.xray.record_tool_call("book_table", args_json="...", result_json="...")

The decorator:

1. On invocation, finds the user-side test driver among the room's
   remote participants and parses its ``xray`` token-claim attribute
   (a JSON blob carrying ``replay_id`` + ``conversation_hash`` +
   ``modality``). No participant metadata set, no
   ``can_update_own_metadata`` grant required.
2. Builds an OTEL :class:`~opentelemetry.context.context.Context`
   carrying the xray.* baggage and ``context.attach``-es it in the
   *caller's* task — so spans the agent emits in the entrypoint's
   scope inherit ``xray.replay.id`` via baggage propagation.
3. Installs :func:`xray.otel.install` (idempotent) on the current
   :class:`~opentelemetry.sdk.trace.TracerProvider`. The bundled
   :class:`XrayBaggageSpanProcessor` lifts each baggage key onto every
   span at start; :class:`XraySpanExporter` POSTs them to xray.
4. Constructs an :class:`XraySession` and attaches it to ``ctx.xray``.
   The session exposes ``turn(idx)`` / ``record_tool_call(...)``.
5. Awaits the wrapped entrypoint. After it returns (or raises),
   force-flushes the tracer provider so spans land in xray before the
   worker shuts down — kills the "BatchSpanProcessor 5s delay" trap.

If the room has no xray-shaped participant attribute, the decorator
runs the entrypoint unchanged: no binding, no flushing, no session.
The wrapped agent is then untouched in production (where xray isn't
in front of the workload).
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import time
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from opentelemetry import baggage, context, trace
from opentelemetry.context.context import Context
from opentelemetry.sdk.trace import TracerProvider
from pydantic import BaseModel, Field, ValidationError

from xray._json import JsonValue
from xray.otel import (
    XRAY_TURN_IDX,
    XRAY_TURN_KEY,
    attach_replay_baggage,
)
from xray.otel import install as install_otel

logger = logging.getLogger(__name__)


# Token-claim attribute key. Single blob; agent-side parses the JSON
# (see _parse_xray_attribute). The driver side puts it on the JWT
# attributes when minting the token.
XRAY_ATTRIBUTE_KEY: Final[str] = "xray"


# How long to wait for a remote participant carrying the xray attribute
# to appear in the room before giving up and running the entrypoint
# without binding. Most setups need <1s; the timeout is generous so a
# flaky LiveKit signal doesn't cause a silent miss.
_BIND_WAIT_S: Final[float] = 10.0


# Default endpoint resolution order:
# 1. explicit `endpoint=` argument to @instrument
# 2. XRAY_OTLP_ENDPOINT env var
# 3. None → no OTLP pipeline installed (just bind baggage in process)
_DEFAULT_ENDPOINT_ENV: Final[str] = "XRAY_OTLP_ENDPOINT"


# ─── Public types ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReplayContext:
    """Parsed xray context for the current run."""

    replay_id: str
    conversation_hash: str
    modality: str


class _HasRoom(Protocol):
    """Duck-type for the ``JobContext`` LiveKit Agents passes in.

    We don't import ``livekit.agents`` so the SDK stays optional. Any
    object exposing ``.room.remote_participants`` (a dict) works.
    """

    room: _HasRemoteParticipants


class _HasRemoteParticipants(Protocol):
    remote_participants: dict[str, _HasAttributes]

    def on(self, event: str, callback: Callable[..., object]) -> object: ...

    def off(self, event: str, callback: Callable[..., object]) -> object: ...


@runtime_checkable
class _HasAttributes(Protocol):
    """Duck-type for ``livekit.rtc.RemoteParticipant`` — only
    ``.attributes`` is read. Runtime-checkable so we can narrow an
    ``object`` from LiveKit's variable-shape event callback."""

    identity: str
    attributes: dict[str, str]


# ─── XraySession ──────────────────────────────────────────────────────


class XraySession:
    """The agent-side handle injected as ``ctx.xray`` by
    :func:`instrument`.

    Methods scope baggage + record domain events that xray's OTLP
    vocabulary recognizes (so they extract into ``replay_turns`` /
    ``tool_calls`` / ``model_usage`` rows on the server).
    """

    def __init__(self, replay_context: ReplayContext, tracer_provider: TracerProvider) -> None:
        self._context = replay_context
        self._tracer_provider = tracer_provider
        self._tracer = trace.get_tracer("xray-py", "0.0.1")

    @property
    def replay_id(self) -> str:
        return self._context.replay_id

    @property
    def conversation_hash(self) -> str:
        return self._context.conversation_hash

    @property
    def modality(self) -> str:
        return self._context.modality

    @asynccontextmanager
    async def turn(self, idx: int, key: str | None = None) -> AsyncGenerator[None, None]:
        """Scope ``xray.turn.idx`` (and optionally ``xray.turn.key``) on
        baggage. Spans emitted inside the block pick up the turn
        attribution via the baggage processor."""
        ctx = context.get_current()
        ctx = baggage.set_baggage(XRAY_TURN_IDX, str(idx), context=ctx)
        if key is not None:
            ctx = baggage.set_baggage(XRAY_TURN_KEY, key, context=ctx)
        # Also emit an xray.turn span so the server's vocabulary
        # registry persists this turn boundary as a replay_turns row.
        token = context.attach(ctx)
        try:
            with self._tracer.start_as_current_span("xray.turn") as span:
                span.set_attribute("xray.turn.idx", idx)
                span.set_attribute("xray.turn.role", "agent")
                if key is not None:
                    span.set_attribute("xray.turn.key", key)
                started = time.time()
                try:
                    yield
                finally:
                    span.set_attribute("xray.turn.duration_ms", int((time.time() - started) * 1000))
        finally:
            context.detach(token)

    def record_tool_call(
        self,
        name: str,
        *,
        args_json: str | None = None,
        result_json: str | None = None,
        latency_ms: int | None = None,
    ) -> None:
        """Emit a ``gen_ai.tool`` span carrying the tool-call payload.

        xray's OTLP vocabulary registry recognizes the GenAI semconv
        namespace and persists this into a ``tool_calls`` row on the
        replay. Attributes follow OTel GenAI semconv keys."""
        with self._tracer.start_as_current_span("execute_tool") as span:
            span.set_attribute("gen_ai.tool.name", name)
            span.set_attribute("gen_ai.operation.name", "execute_tool")
            if args_json is not None:
                span.set_attribute("gen_ai.tool.arguments", args_json)
            if result_json is not None:
                span.set_attribute("gen_ai.tool.message", result_json)
            if latency_ms is not None:
                span.set_attribute("gen_ai.latency_ms", latency_ms)


# ─── xray.attach(ctx, …) — async context manager ──────────────────────


@asynccontextmanager
async def attach(
    ctx: _HasRoom,
    *,
    service_name: str | None = None,
    endpoint: str | None = None,
    bind_timeout_s: float = _BIND_WAIT_S,
) -> AsyncGenerator[XraySession | None, None]:
    """Wire xray onto an existing LiveKit Agents worker entrypoint.

    ``async with xray.attach(ctx, service_name="voice-service") as session:``
    inside the entrypoint:

    1. Parses the joined user-side participant's token-claim ``xray``
       attribute, binds the replay context onto OTEL baggage for the
       *calling* task (so spans emitted in the body inherit
       ``xray.replay.id``).
    2. Installs the xray OTLP/JSON pipeline on the active tracer
       provider when ``endpoint`` or ``XRAY_OTLP_ENDPOINT`` env var is
       set. Idempotent across multiple workers in the same process.
    3. Attaches a :class:`XraySession` to ``ctx.xray`` and yields it.
    4. On block exit, detaches baggage and force-flushes the tracer
       provider so spans land in xray before the worker shuts down.

    If no participant carries the xray attribute, yields ``None`` —
    the body still runs but no session is wired.

    A context-manager interface (instead of the more obvious
    ``@instrument`` decorator) is used because LiveKit Agents pickles
    the entrypoint across a multiprocessing forkserver boundary, and
    wrapper-class decorators trigger
    ``_pickle.PicklingError: Can't pickle <function entrypoint ...>:
    it's not the same object as __main__.entrypoint``. The CM keeps
    the wrapped function shape intact.
    """
    resolved_endpoint = endpoint or os.environ.get(_DEFAULT_ENDPOINT_ENV) or None
    tracer_provider: TracerProvider | None = None
    if resolved_endpoint is not None:
        tracer_provider = install_otel(endpoint=resolved_endpoint)

    replay_context = await _wait_for_replay_context(ctx, bind_timeout_s)
    attach_token: contextvars.Token[Context] | None = None
    session: XraySession | None = None

    if replay_context is not None:
        attach_token = attach_replay_baggage(
            replay_id=replay_context.replay_id,
            conversation_hash=replay_context.conversation_hash,
            modality=replay_context.modality,
        )
        if tracer_provider is not None:
            session = XraySession(replay_context, tracer_provider)
            logger.info(
                "xray attached: replay=%s service=%s",
                replay_context.replay_id,
                service_name or "<unset>",
            )
    else:
        logger.info(
            "xray bind skipped: no participant attribute found in %.1fs",
            bind_timeout_s,
        )

    try:
        yield session
    finally:
        if attach_token is not None:
            context.detach(attach_token)
        if tracer_provider is not None:
            tracer_provider.force_flush(timeout_millis=10_000)


# ─── Helpers ──────────────────────────────────────────────────────────


async def _wait_for_replay_context(ctx: _HasRoom, timeout_s: float) -> ReplayContext | None:
    """Poll for + listen for a remote participant exposing the xray
    JSON-blob attribute. Combine an initial scan with a one-shot
    ``participant_attributes_changed`` listener so whichever fires
    first wins."""
    room = ctx.room
    loop = asyncio.get_running_loop()
    found: asyncio.Future[ReplayContext] = loop.create_future()

    def _try_capture(participant: _HasAttributes) -> bool:
        if found.done():
            return True
        parsed = _parse_xray_attribute(participant.attributes)
        if parsed is None:
            return False
        found.set_result(parsed)
        return True

    def _on_attributes_changed(
        _changed: object, participant: object = None, *_args: object
    ) -> None:
        # LiveKit emits this with variable argument order across versions;
        # the participant is somewhere in the args. Pick whichever has
        # the right shape.
        target = participant if participant is not None else _changed
        if isinstance(target, _HasAttributes):
            _try_capture(target)

    # Hook the event handler before scanning so we don't miss a change
    # that fires between the scan and the await.
    room.on("participant_attributes_changed", _on_attributes_changed)
    try:
        for participant in room.remote_participants.values():
            if _try_capture(participant):
                break

        if not found.done():
            try:
                await asyncio.wait_for(asyncio.shield(found), timeout=timeout_s)
            except asyncio.TimeoutError:
                return None
        return found.result()
    finally:
        room.off("participant_attributes_changed", _on_attributes_changed)


class _ReplayContextPayload(BaseModel):
    """Inbound shape of the JWT ``xray`` attribute. Validates the JSON
    blob at the trust boundary so the rest of the SDK works with a
    typed value."""

    replay_id: str = Field(min_length=1)
    conversation_hash: str = Field(min_length=1)
    modality: str = "voice"


def _parse_xray_attribute(attributes: dict[str, str]) -> ReplayContext | None:
    raw = attributes.get(XRAY_ATTRIBUTE_KEY)
    if not raw:
        return None
    try:
        parsed = _ReplayContextPayload.model_validate_json(raw)
    except ValidationError:
        return None
    return ReplayContext(
        replay_id=parsed.replay_id,
        conversation_hash=parsed.conversation_hash,
        modality=parsed.modality,
    )


# Re-exported for the driver side (LiveKitRuntime builds the same JSON).
def encode_attribute(
    *,
    replay_id: str,
    conversation_hash: str,
    modality: str = "voice",
) -> dict[str, str]:
    """Build the ``{"xray": "<json>"}`` token-claim attribute the
    driver puts on the JWT. The agent-side reads this via
    ``participant.attributes``."""
    payload: dict[str, JsonValue] = {
        "replay_id": replay_id,
        "conversation_hash": conversation_hash,
        "modality": modality,
    }
    return {XRAY_ATTRIBUTE_KEY: json.dumps(payload, separators=(",", ":"))}


__all__ = [
    "ReplayContext",
    "XraySession",
    "attach",
    "encode_attribute",
]
