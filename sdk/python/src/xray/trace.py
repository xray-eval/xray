"""OpenTelemetry decorators that propagate ``xray.replay.id`` from LiveKit
room metadata via OTEL baggage.

The dev's agent calls ``set_replay_context(...)`` once when joining the
room (with the values from ``LocalParticipant.metadata`` or the SDK's
helper) — every subsequent ``@stage(...)``-decorated call attaches the
context to its span, and any downstream ``gen_ai.*`` / ``langfuse.*``
spans the agent emits inherit it via baggage propagation.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from functools import wraps
from typing import Any, Literal, ParamSpec, TypeVar

from opentelemetry import baggage, context, trace
from opentelemetry.trace import Span, Status, StatusCode

P = ParamSpec("P")
R = TypeVar("R")

_tracer = trace.get_tracer("xray-py", "0.0.1")

XRAY_REPLAY_ID = "xray.replay.id"
XRAY_CONVERSATION_ID = "xray.conversation.id"
XRAY_CONVERSATION_VERSION = "xray.conversation.version"
XRAY_TURN_KEY = "xray.turn.key"
XRAY_TURN_IDX = "xray.turn.idx"
XRAY_MODALITY = "xray.modality"


def set_replay_context(
    replay_id: str,
    conversation_id: str,
    conversation_version: str,
    modality: Literal["voice"] = "voice",
) -> object:
    """Attach the replay's identity to the current OTEL context so every
    span emitted from now on (in this task / thread) inherits it.
    """
    ctx = context.get_current()
    ctx = baggage.set_baggage(XRAY_REPLAY_ID, replay_id, context=ctx)
    ctx = baggage.set_baggage(XRAY_CONVERSATION_ID, conversation_id, context=ctx)
    ctx = baggage.set_baggage(XRAY_CONVERSATION_VERSION, conversation_version, context=ctx)
    ctx = baggage.set_baggage(XRAY_MODALITY, modality, context=ctx)
    return context.attach(ctx)


def detach(token: object) -> None:
    context.detach(token)  # type: ignore[arg-type]


@contextmanager
def replay_context(
    replay_id: str,
    conversation_id: str,
    conversation_version: str,
    modality: Literal["voice"] = "voice",
):
    """Scoped variant of ``set_replay_context``."""
    token = set_replay_context(replay_id, conversation_id, conversation_version, modality)
    try:
        yield
    finally:
        detach(token)


def _stamp_baggage(span: Span) -> None:
    """Lift current baggage onto the span as xray.* resource-style attrs."""
    for key in (
        XRAY_REPLAY_ID,
        XRAY_CONVERSATION_ID,
        XRAY_CONVERSATION_VERSION,
        XRAY_MODALITY,
    ):
        value = baggage.get_baggage(key)
        if value is not None:
            span.set_attribute(key, str(value))


def stage(name: Literal["stt", "tts"]) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorator for STT/TTS stage timing.

    Wraps the decorated function in a span named ``xray.stage.<name>`` and
    stamps the current baggage on it. Sync and async functions both work.
    """

    span_name = f"xray.stage.{name}"

    def decorator(fn: Callable[P, R]) -> Callable[P, R]:
        if _is_coroutine_function(fn):
            async_fn: Callable[P, Awaitable[Any]] = fn  # type: ignore[assignment]

            @wraps(fn)
            async def async_wrapper(*args: P.args, **kwargs: P.kwargs) -> Any:
                with _tracer.start_as_current_span(span_name) as span:
                    _stamp_baggage(span)
                    try:
                        return await async_fn(*args, **kwargs)
                    except Exception as e:  # noqa: BLE001
                        span.record_exception(e)
                        span.set_status(Status(StatusCode.ERROR))
                        raise

            return async_wrapper  # type: ignore[return-value]

        @wraps(fn)
        def sync_wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            with _tracer.start_as_current_span(span_name) as span:
                _stamp_baggage(span)
                try:
                    return fn(*args, **kwargs)
                except Exception as e:  # noqa: BLE001
                    span.record_exception(e)
                    span.set_status(Status(StatusCode.ERROR))
                    raise

        return sync_wrapper

    return decorator


def _is_coroutine_function(fn: Callable[..., Any]) -> bool:
    import asyncio

    return asyncio.iscoroutinefunction(fn)
