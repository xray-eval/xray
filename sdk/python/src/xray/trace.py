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

Type safety: ``stage()`` exposes two overloads so sync and async
callables keep their signatures end-to-end. ``BaggageKey`` is a closed
``Literal`` so a typo on a baggage key is a static error.
"""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from functools import wraps
from typing import Final, Literal, ParamSpec, TypeAlias, TypeGuard, TypeVar, overload

from opentelemetry import baggage, context, trace
from opentelemetry.context import Token
from opentelemetry.trace import Span

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
) -> Token:
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


def detach(token: Token) -> None:
    """Undo a prior ``set_replay_context`` / ``_attach_turn_context`` attach."""
    context.detach(token)


@contextmanager
def replay_context(
    replay_id: str,
    conversation_id: str,
    conversation_version: str,
    modality: Modality = "voice",
) -> Iterator[None]:
    """Scoped variant of ``set_replay_context``."""
    token = set_replay_context(replay_id, conversation_id, conversation_version, modality)
    try:
        yield
    finally:
        detach(token)


def _attach_turn_context(idx: int, key: str | None) -> Token:
    ctx = context.get_current()
    ctx = baggage.set_baggage(XRAY_TURN_IDX, str(idx), context=ctx)
    if key is not None:
        ctx = baggage.set_baggage(XRAY_TURN_KEY, key, context=ctx)
    return context.attach(ctx)


@contextmanager
def turn(idx: int, key: str | None = None) -> Iterator[None]:
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
async def aturn(idx: int, key: str | None = None) -> AsyncIterator[None]:
    """Async variant of :func:`turn` — same semantics, usable from
    ``async with``."""
    token = _attach_turn_context(idx, key)
    try:
        yield
    finally:
        detach(token)


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


def _is_coroutine_callable(
    fn: Callable[P, Awaitable[R]] | Callable[P, R],
) -> TypeGuard[Callable[P, Awaitable[R]]]:
    """Narrow the sync/async union via a real TypeGuard so neither
    branch of ``stage()`` needs a cast or a type-checker suppression."""
    return inspect.iscoroutinefunction(fn)


def stage(name: StageName) -> _AsyncOrSyncDecorator:
    """Decorator for STT/TTS stage timing.

    Wraps the decorated function in a span named ``xray.stage.<name>`` and
    stamps the current baggage on it. Sync and async functions both work;
    ``_AsyncOrSyncDecorator.__call__`` is overloaded so the wrapped
    function keeps its exact signature.
    """
    return _AsyncOrSyncDecorator(f"xray.stage.{name}")


class _AsyncOrSyncDecorator:
    """Callable object whose ``__call__`` is overloaded so sync- and
    async-decorated functions both keep their signatures.

    Implemented as a class (not a closure) because pyright resolves
    ``__call__`` overloads on the class, which is the simplest way to
    write a signature-preserving decorator without ``Any``.
    """

    def __init__(self, span_name: str) -> None:
        self._span_name = span_name

    @overload
    def __call__(self, fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]: ...
    @overload
    def __call__(self, fn: Callable[P, R]) -> Callable[P, R]: ...
    def __call__(
        self, fn: Callable[P, Awaitable[R]] | Callable[P, R]
    ) -> Callable[P, Awaitable[R]] | Callable[P, R]:
        span_name = self._span_name
        if _is_coroutine_callable(fn):
            async_fn: Callable[P, Awaitable[R]] = fn

            @wraps(async_fn)
            async def async_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
                with _tracer.start_as_current_span(span_name) as span:
                    _stamp_baggage(span)
                    return await async_fn(*args, **kwargs)

            return async_wrapper

        sync_fn: Callable[P, R] = fn

        @wraps(sync_fn)
        def sync_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with _tracer.start_as_current_span(span_name) as span:
                _stamp_baggage(span)
                return sync_fn(*args, **kwargs)

        return sync_wrapper


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
    "aturn",
    "detach",
    "replay_context",
    "set_replay_context",
    "stage",
    "turn",
]
