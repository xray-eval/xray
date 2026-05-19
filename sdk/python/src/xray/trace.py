"""OpenTelemetry decorators that propagate ``xray.replay.id`` from LiveKit
room metadata via OTEL baggage.

The dev's agent calls ``set_replay_context(...)`` once when joining the
room (with the values from ``LocalParticipant.metadata`` or the SDK's
helper) — every subsequent ``@stage(...)``-decorated call attaches the
context to its span, and any downstream ``gen_ai.*`` / ``langfuse.*``
spans the agent emits inherit it via baggage propagation.

``turn(idx, key)`` scopes the per-turn baggage (``xray.turn.idx``,
``xray.turn.key``) — spans emitted inside the scope get attributed to
that turn on the server side.

Type safety: ``stage()`` decorates sync functions; ``astage()`` decorates
async ones. Splitting keeps the wrapped function's ``ParamSpec`` and
return type exact, which a single-decorator variant can't express
under ``pyright --strict``. ``BaggageKey`` is a closed ``Literal`` so
a typo on a baggage key is a static error.
"""

from __future__ import annotations

import contextvars
from collections.abc import AsyncGenerator, Awaitable, Callable, Generator
from contextlib import asynccontextmanager, contextmanager
from functools import wraps
from typing import Final, Literal, ParamSpec, Protocol, TypeAlias, TypeVar

from opentelemetry import baggage, context, trace
from opentelemetry.context.context import Context
from opentelemetry.trace import Span
from pydantic import BaseModel, Field, ValidationError

from xray.errors import MissingReplayContextError

# OTEL's public re-exports don't expose ``Token`` cleanly under strict
# typing, so we type ``attach``'s return as the underlying
# ``contextvars.Token[Context]`` shape that OTEL actually returns.
_Token: TypeAlias = "contextvars.Token[Context]"

P = ParamSpec("P")
R = TypeVar("R")

_tracer = trace.get_tracer("xray-py", "0.0.1")

# Closed set of baggage keys the SDK reads/writes. A typo is a static
# error because the helpers below take this Literal, not a bare str.
BaggageKey: TypeAlias = Literal[
    "xray.replay.id",
    "xray.conversation.id",
    "xray.conversation.version",
    "xray.turn.key",
    "xray.turn.idx",
    "xray.modality",
]

XRAY_REPLAY_ID: Final[BaggageKey] = "xray.replay.id"
XRAY_CONVERSATION_ID: Final[BaggageKey] = "xray.conversation.id"
XRAY_CONVERSATION_VERSION: Final[BaggageKey] = "xray.conversation.version"
XRAY_TURN_KEY: Final[BaggageKey] = "xray.turn.key"
XRAY_TURN_IDX: Final[BaggageKey] = "xray.turn.idx"
XRAY_MODALITY: Final[BaggageKey] = "xray.modality"

StageName: TypeAlias = Literal["stt", "tts"]
Modality: TypeAlias = Literal["voice"]


def set_replay_context(
    replay_id: str,
    conversation_id: str,
    conversation_version: str,
    modality: Modality = "voice",
) -> _Token:
    """Attach the replay's identity to the current OTEL context so every
    span emitted from now on (in this task / thread) inherits it.

    Returns a detach token. Pass it to :func:`detach` to undo.
    """
    ctx = context.get_current()
    ctx = baggage.set_baggage(XRAY_REPLAY_ID, replay_id, context=ctx)
    ctx = baggage.set_baggage(XRAY_CONVERSATION_ID, conversation_id, context=ctx)
    ctx = baggage.set_baggage(XRAY_CONVERSATION_VERSION, conversation_version, context=ctx)
    ctx = baggage.set_baggage(XRAY_MODALITY, modality, context=ctx)
    return context.attach(ctx)


def detach(token: _Token) -> None:
    """Undo a prior ``set_replay_context`` / ``_attach_turn_context`` attach."""
    context.detach(token)


@contextmanager
def replay_context(
    replay_id: str,
    conversation_id: str,
    conversation_version: str,
    modality: Modality = "voice",
) -> Generator[None, None, None]:
    """Scoped variant of ``set_replay_context``."""
    token = set_replay_context(replay_id, conversation_id, conversation_version, modality)
    try:
        yield
    finally:
        detach(token)


def _attach_turn_context(idx: int, key: str | None) -> _Token:
    ctx = context.get_current()
    ctx = baggage.set_baggage(XRAY_TURN_IDX, str(idx), context=ctx)
    if key is not None:
        ctx = baggage.set_baggage(XRAY_TURN_KEY, key, context=ctx)
    return context.attach(ctx)


@contextmanager
def turn(idx: int, key: str | None = None) -> Generator[None, None, None]:
    """Scope ``xray.turn.idx`` (and optionally ``xray.turn.key``) baggage to
    a block. Every ``gen_ai.*`` / ``langfuse.*`` span emitted inside the
    block inherits the turn attribution via baggage propagation — the
    server's OTLP receiver folds that into ``turn_idx`` on
    ``model_usage`` / ``tool_calls`` rows.
    """
    token = _attach_turn_context(idx, key)
    try:
        yield
    finally:
        detach(token)


@asynccontextmanager
async def aturn(idx: int, key: str | None = None) -> AsyncGenerator[None, None]:
    """Async variant of :func:`turn` — same semantics, usable from
    ``async with``."""
    token = _attach_turn_context(idx, key)
    try:
        yield
    finally:
        detach(token)


class _HasMetadata(Protocol):
    """Duck-type for ``livekit.rtc.Room`` — only ``.metadata`` is read."""

    metadata: str | None


class _RoomMetadata(BaseModel):
    """Pydantic narrow of the JSON shape the orchestrator writes into
    ``Room.metadata`` before the agent joins. Field aliases match the
    ``xray.*`` baggage keys verbatim so the dev's runtime + the SDK speak
    the same wire vocab."""

    replay_id: str = Field(alias=XRAY_REPLAY_ID, min_length=1)
    conversation_id: str = Field(alias=XRAY_CONVERSATION_ID, min_length=1)
    conversation_version: str = Field(alias=XRAY_CONVERSATION_VERSION, min_length=1)
    modality: Modality = Field(alias=XRAY_MODALITY, default="voice")


def bind_from_livekit_room(room: _HasMetadata) -> _Token:
    """Read ``room.metadata`` (set by the orchestrator before the agent
    joined), parse the xray replay-context keys, and push them onto baggage.

    Raises ``MissingReplayContextError`` if the metadata is empty, isn't
    JSON, or doesn't carry the expected keys. Returns a detach token.
    """
    raw = room.metadata
    if raw is None or raw == "":
        raise MissingReplayContextError("room metadata is empty")
    try:
        meta = _RoomMetadata.model_validate_json(raw)
    except ValidationError as e:
        raise MissingReplayContextError(f"room metadata invalid: {e}") from e
    return set_replay_context(
        replay_id=meta.replay_id,
        conversation_id=meta.conversation_id,
        conversation_version=meta.conversation_version,
        modality=meta.modality,
    )


def _stamp_baggage(span: Span) -> None:
    """Lift current baggage onto the span as xray.* attrs."""
    keys: tuple[BaggageKey, ...] = (
        XRAY_REPLAY_ID,
        XRAY_CONVERSATION_ID,
        XRAY_CONVERSATION_VERSION,
        XRAY_MODALITY,
        XRAY_TURN_IDX,
        XRAY_TURN_KEY,
    )
    for key in keys:
        value = baggage.get_baggage(key)
        if value is not None:
            span.set_attribute(key, str(value))


def stage(name: StageName) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorator for STT/TTS stage timing on a **sync** function.

    Wraps the decorated function in a span named ``xray.stage.<name>``
    and stamps the current baggage on it. For ``async def`` functions
    use :func:`astage` — Python's type system can't express a
    signature-preserving decorator that works for both kinds without
    losing the wrapped function's exact ``ParamSpec`` + return type.
    """
    span_name = f"xray.stage.{name}"

    def decorator(fn: Callable[P, R]) -> Callable[P, R]:
        @wraps(fn)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with _tracer.start_as_current_span(span_name) as span:
                _stamp_baggage(span)
                return fn(*args, **kwargs)

        return wrapper

    return decorator


def astage(
    name: StageName,
) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    """Async variant of :func:`stage`. Use on ``async def`` functions —
    e.g. ``@astage("stt")`` around your STT call."""
    span_name = f"xray.stage.{name}"

    def decorator(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with _tracer.start_as_current_span(span_name) as span:
                _stamp_baggage(span)
                return await fn(*args, **kwargs)

        return wrapper

    return decorator


__all__ = [
    "BaggageKey",
    "Modality",
    "StageName",
    "XRAY_CONVERSATION_ID",
    "XRAY_CONVERSATION_VERSION",
    "XRAY_MODALITY",
    "XRAY_REPLAY_ID",
    "XRAY_TURN_IDX",
    "XRAY_TURN_KEY",
    "astage",
    "aturn",
    "bind_from_livekit_room",
    "detach",
    "replay_context",
    "set_replay_context",
    "stage",
    "turn",
]
