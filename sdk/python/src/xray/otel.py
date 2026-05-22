"""OpenTelemetry pipeline helpers — the SDK ships everything an
existing OTEL-instrumented agent needs to forward spans to xray.

Three pieces:

- :class:`XrayBaggageSpanProcessor` — at span start, lifts ``xray.*``
  baggage onto span attributes. xray's OTLP receiver routes by reading
  ``xray.replay.id`` from span attrs; OTEL baggage alone never lands
  on a span without an explicit processor, so we ship one.

- :class:`XraySpanExporter` — POSTs spans to ``${endpoint}/v1/otlp/v1/traces``
  as OTLP/JSON. xray accepts both protobuf and JSON, but the SDK only
  emits JSON; one fewer encoding step on the SDK side.

- :func:`install` — registers both onto the active OTEL
  :class:`TracerProvider` (or constructs one if the global is the no-op
  default). Idempotent — calling twice doesn't double-register.

Designed so a dev who already has an OTEL setup can call
``xray.otel.install(endpoint=...)`` once and forget about the wiring.
The agent's existing spans inherit the xray attribution as long as the
replay context is on baggage (see :func:`xray.instrument`).
"""

from __future__ import annotations

import contextvars
import logging
import weakref
from collections.abc import Sequence
from typing import ClassVar, Final

import httpx
from google.protobuf.json_format import MessageToJson
from opentelemetry import baggage, context, trace
from opentelemetry.context.context import Context
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from typing_extensions import override

logger = logging.getLogger(__name__)


_DEFAULT_HTTP_TIMEOUT_S: Final[float] = 10.0


XRAY_REPLAY_ID: Final[str] = "xray.replay.id"
XRAY_CONVERSATION_HASH: Final[str] = "xray.conversation.hash"
XRAY_MODALITY: Final[str] = "xray.modality"
XRAY_TURN_IDX: Final[str] = "xray.turn.idx"
XRAY_TURN_KEY: Final[str] = "xray.turn.key"


_XRAY_BAGGAGE_KEYS: Final[tuple[str, ...]] = (
    XRAY_REPLAY_ID,
    XRAY_CONVERSATION_HASH,
    XRAY_MODALITY,
    XRAY_TURN_IDX,
    XRAY_TURN_KEY,
)


def attach_replay_baggage(
    *,
    replay_id: str,
    conversation_hash: str,
    modality: str,
) -> contextvars.Token[Context]:
    """Set the replay-scope baggage keys on the current OTEL context.
    The bundled :class:`XrayBaggageSpanProcessor` lifts these onto
    every span at start so xray's OTLP receiver can route by
    ``xray.replay.id``.

    Both sides of a run call this: the agent worker via
    :func:`xray.attach`, and the driver via :func:`xray.run`. Returns
    the token from :func:`opentelemetry.context.attach` — callers must
    pass it to ``context.detach`` before the run scope exits.
    """
    ctx = context.get_current()
    ctx = baggage.set_baggage(XRAY_REPLAY_ID, replay_id, context=ctx)
    ctx = baggage.set_baggage(XRAY_CONVERSATION_HASH, conversation_hash, context=ctx)
    ctx = baggage.set_baggage(XRAY_MODALITY, modality, context=ctx)
    return context.attach(ctx)


class XrayBaggageSpanProcessor(SpanProcessor):
    """Copy active ``xray.*`` baggage onto every span at start.

    xray's OTLP receiver routes by reading ``xray.replay.id`` from span
    attributes (see ``src/server/otlp/otlp.service.ts``). Vanilla OTEL
    exporters never lift baggage onto span attrs automatically — this
    processor is the lift step.
    """

    _BAGGAGE_KEYS: ClassVar[tuple[str, ...]] = _XRAY_BAGGAGE_KEYS

    @override
    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        ctx = parent_context if parent_context is not None else context.get_current()
        for key in self._BAGGAGE_KEYS:
            value = baggage.get_baggage(key, ctx)
            if value is not None:
                span.set_attribute(key, str(value))

    @override
    def on_end(self, span: ReadableSpan) -> None: ...

    @override
    def shutdown(self) -> None: ...

    @override
    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        del timeout_millis
        return True


class XraySpanExporter(SpanExporter):
    """Export OTel spans to xray as OTLP/JSON.

    Encodes via the official ``encode_spans`` (producing the protobuf
    ``ExportTraceServiceRequest``), serializes to JSON via
    ``MessageToJson`` (preserving the OTLP/JSON wire shape), POSTs to
    ``${endpoint}/v1/otlp/v1/traces`` with ``Content-Type:
    application/json``. xray's receiver accepts both encodings; we use
    JSON to keep the SDK stack small.

    ``endpoint`` is the xray base URL (e.g. ``http://localhost:8080``).
    The exporter appends the standard OTLP path.
    """

    _TRACES_PATH: ClassVar[str] = "/v1/otlp/v1/traces"

    def __init__(self, *, endpoint: str, timeout_s: float = _DEFAULT_HTTP_TIMEOUT_S) -> None:
        self._endpoint = endpoint.rstrip("/") + self._TRACES_PATH
        self._timeout_s = timeout_s
        self._client = httpx.Client(timeout=timeout_s)
        self._shutdown = False

    @override
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self._shutdown:
            return SpanExportResult.FAILURE
        try:
            proto = encode_spans(spans)
            body = MessageToJson(proto, preserving_proto_field_name=False)
            response = self._client.post(
                self._endpoint,
                content=body,
                headers={"Content-Type": "application/json"},
            )
            if response.status_code != 200:
                logger.warning(
                    "xray OTLP export failed: %s %s",
                    response.status_code,
                    response.text[:200],
                )
                return SpanExportResult.FAILURE
        except Exception:
            logger.exception("xray OTLP export raised; dropping batch")
            return SpanExportResult.FAILURE
        return SpanExportResult.SUCCESS

    @override
    def shutdown(self) -> None:
        self._shutdown = True
        self._client.close()

    @override
    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        del timeout_millis
        return True


def install(
    *,
    endpoint: str,
    tracer_provider: TracerProvider | None = None,
) -> TracerProvider:
    """Wire :class:`XraySpanExporter` + :class:`XrayBaggageSpanProcessor`
    onto ``tracer_provider``. When ``tracer_provider`` is ``None``, use
    the global one if it's a real :class:`TracerProvider`; otherwise
    construct and set a fresh one.

    Idempotent: calling twice with the same endpoint won't double-register
    the exporter (the second call is a no-op on the same provider).

    Returns the :class:`TracerProvider` that ended up with the
    processors. Callers can keep a handle for ``force_flush`` at
    shutdown.
    """
    if tracer_provider is None:
        candidate = trace.get_tracer_provider()
        if isinstance(candidate, TracerProvider):
            tracer_provider = candidate
        else:
            tracer_provider = TracerProvider()
            trace.set_tracer_provider(tracer_provider)

    if _already_installed(tracer_provider, endpoint):
        return tracer_provider

    tracer_provider.add_span_processor(XrayBaggageSpanProcessor())
    tracer_provider.add_span_processor(BatchSpanProcessor(XraySpanExporter(endpoint=endpoint)))
    _mark_installed(tracer_provider, endpoint)
    logger.info("xray OTLP/JSON pipeline installed (endpoint=%s)", endpoint)
    return tracer_provider


# Tracer providers don't expose their processor list; we track per-provider
# install state in a WeakKeyDictionary so the entry disappears when the
# provider is GC'd. Module-level state avoids monkey-patching TracerProvider.
_INSTALLED_ENDPOINTS: weakref.WeakKeyDictionary[TracerProvider, set[str]] = (
    weakref.WeakKeyDictionary()
)


def _already_installed(tracer_provider: TracerProvider, endpoint: str) -> bool:
    return endpoint in _INSTALLED_ENDPOINTS.get(tracer_provider, set())


def _mark_installed(tracer_provider: TracerProvider, endpoint: str) -> None:
    installed = _INSTALLED_ENDPOINTS.setdefault(tracer_provider, set())
    installed.add(endpoint)


__all__ = [
    "XrayBaggageSpanProcessor",
    "XraySpanExporter",
    "install",
]
