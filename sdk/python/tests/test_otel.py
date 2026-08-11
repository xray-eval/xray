"""Direct tests for the OTEL pipeline the SDK ships: the baggage lift,
the OTLP/JSON exporter, and the idempotent ``install``.

No global tracer provider is touched — every test builds its own
:class:`TracerProvider` so nothing leaks into the rest of the session.
HTTP is intercepted with respx, same as ``test_orchestrator.py``.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest
import respx
from opentelemetry import baggage, context
from opentelemetry.context.context import Context
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from xray.otel import (
    XRAY_CONVERSATION_HASH,
    XRAY_MODALITY,
    XRAY_REPLAY_ID,
    XRAY_TURN_IDX,
    XRAY_TURN_KEY,
    XrayBaggageSpanProcessor,
    XraySpanExporter,
    attach_replay_baggage,
    install,
)

_ENDPOINT = "http://xray.test"
_TRACES_PATH = "/v1/otlp/v1/traces"
_HASH = "a" * 64


def _lifting_provider() -> tuple[TracerProvider, InMemorySpanExporter]:
    """A provider with the baggage lift in front of an in-memory exporter,
    i.e. exactly what ``install`` wires up minus the HTTP hop."""
    provider = TracerProvider()
    memory = InMemorySpanExporter()
    provider.add_span_processor(XrayBaggageSpanProcessor())
    provider.add_span_processor(SimpleSpanProcessor(memory))
    return provider, memory


def _one_span(memory: InMemorySpanExporter) -> ReadableSpan:
    finished = memory.get_finished_spans()
    assert len(finished) == 1, f"expected one span, got {len(finished)}"
    return finished[0]


def _finished_spans() -> tuple[ReadableSpan, ...]:
    """Real ``ReadableSpan``s to feed the exporter — the OTLP encoder
    rejects anything hand-rolled."""
    provider = TracerProvider()
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    tracer = provider.get_tracer("xray-py-test", "0.0.1")
    with tracer.start_as_current_span("agent.step") as span:
        span.set_attribute(XRAY_REPLAY_ID, "rep-1")
    return memory.get_finished_spans()


def _raw_body(route: respx.Route) -> bytes:
    call = route.calls[0]
    request_obj: object = getattr(call, "request", None)
    content_obj: object = getattr(request_obj, "content", b"")
    assert isinstance(content_obj, bytes)
    return content_obj


def _content_type(route: respx.Route) -> str | None:
    call = route.calls[0]
    request_obj: object = getattr(call, "request", None)
    headers_obj: object = getattr(request_obj, "headers", None)
    assert isinstance(headers_obj, httpx.Headers)
    header = headers_obj.get("content-type")
    assert header is None or isinstance(header, str)
    return header


def test_attach_replay_baggage_sets_all_three_keys_and_detach_clears_them():
    token = attach_replay_baggage(replay_id="rep-1", conversation_hash=_HASH, modality="voice")
    try:
        assert baggage.get_baggage(XRAY_REPLAY_ID) == "rep-1"
        assert baggage.get_baggage(XRAY_CONVERSATION_HASH) == _HASH
        assert baggage.get_baggage(XRAY_MODALITY) == "voice"
    finally:
        context.detach(token)
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None


def test_baggage_processor_lifts_replay_keys_onto_span_attributes():
    """xray's OTLP receiver routes on the span *attribute* ``xray.replay.id``;
    baggage alone never reaches the wire. Without this lift every span the
    agent emits is dropped as an unknown replay."""
    provider, memory = _lifting_provider()
    tracer = provider.get_tracer("xray-py-test", "0.0.1")
    token = attach_replay_baggage(replay_id="rep-1", conversation_hash=_HASH, modality="voice")
    try:
        with tracer.start_as_current_span("agent.step"):
            pass
    finally:
        context.detach(token)

    attrs = _one_span(memory).attributes or {}
    assert attrs.get(XRAY_REPLAY_ID) == "rep-1"
    assert attrs.get(XRAY_CONVERSATION_HASH) == _HASH
    assert attrs.get(XRAY_MODALITY) == "voice"


def test_baggage_processor_lifts_turn_keys_as_strings():
    provider, memory = _lifting_provider()
    tracer = provider.get_tracer("xray-py-test", "0.0.1")
    ctx = baggage.set_baggage(XRAY_TURN_IDX, 3, context=Context())
    ctx = baggage.set_baggage(XRAY_TURN_KEY, "a0", context=ctx)
    token = context.attach(ctx)
    try:
        with tracer.start_as_current_span("agent.step"):
            pass
    finally:
        context.detach(token)

    attrs = _one_span(memory).attributes or {}
    # Baggage values are untyped; the receiver's vocabulary reads a string.
    assert attrs.get(XRAY_TURN_IDX) == "3"
    assert attrs.get(XRAY_TURN_KEY) == "a0"


def test_baggage_processor_leaves_spans_untouched_when_no_replay_is_bound():
    """An agent running in production (no xray in front of it) must not get
    empty-string xray attributes stamped on every span."""
    provider, memory = _lifting_provider()
    tracer = provider.get_tracer("xray-py-test", "0.0.1")
    token = context.attach(Context())
    try:
        with tracer.start_as_current_span("agent.step"):
            pass
    finally:
        context.detach(token)

    attrs = _one_span(memory).attributes or {}
    assert XRAY_REPLAY_ID not in attrs
    assert XRAY_MODALITY not in attrs


def test_baggage_processor_prefers_the_parent_context_over_the_ambient_one():
    """A span started with an explicit parent context inherits *that* run's
    replay id — spans handed a context across a task boundary must not pick
    up whatever happens to be attached in the calling task."""
    provider, memory = _lifting_provider()
    tracer = provider.get_tracer("xray-py-test", "0.0.1")
    parent = baggage.set_baggage(XRAY_REPLAY_ID, "rep-from-parent", context=Context())
    ambient = context.attach(
        baggage.set_baggage(XRAY_REPLAY_ID, "rep-ambient", context=Context()),
    )
    try:
        tracer.start_span("agent.step", context=parent).end()
    finally:
        context.detach(ambient)

    attrs = _one_span(memory).attributes or {}
    assert attrs.get(XRAY_REPLAY_ID) == "rep-from-parent"


def test_export_posts_otlp_json_to_the_traces_path_and_reports_success():
    spans = _finished_spans()
    with respx.mock(base_url=_ENDPOINT) as mock:
        route = mock.post(_TRACES_PATH).mock(return_value=httpx.Response(200, json={}))
        # Trailing slash on the base URL must not produce a doubled path.
        exporter = XraySpanExporter(endpoint=_ENDPOINT + "/")
        try:
            result = exporter.export(spans)
        finally:
            exporter.shutdown()

    assert result is SpanExportResult.SUCCESS
    assert route.call_count == 1
    assert _content_type(route) == "application/json"
    parsed: object = json.loads(_raw_body(route).decode("utf-8"))
    assert isinstance(parsed, dict)
    # OTLP/JSON is lowerCamelCase on the wire — the server's receiver parses
    # `resourceSpans`, not the protobuf field names.
    assert "resourceSpans" in parsed
    assert "agent.step" in _raw_body(route).decode("utf-8")


def test_export_reports_failure_when_the_server_rejects_the_batch():
    """A non-200 must be FAILURE so the BatchSpanProcessor's retry/telemetry
    accounting sees the drop instead of counting it as delivered."""
    spans = _finished_spans()
    with respx.mock(base_url=_ENDPOINT) as mock:
        mock.post(_TRACES_PATH).mock(return_value=httpx.Response(500, text="boom"))
        exporter = XraySpanExporter(endpoint=_ENDPOINT)
        try:
            result = exporter.export(spans)
        finally:
            exporter.shutdown()

    assert result is SpanExportResult.FAILURE


def test_export_swallows_transport_errors_and_reports_failure():
    """The exporter runs on the BatchSpanProcessor's worker thread; letting an
    unreachable xray raise would kill the agent's export loop for good."""
    spans = _finished_spans()
    with respx.mock(base_url=_ENDPOINT) as mock:
        mock.post(_TRACES_PATH).mock(side_effect=httpx.ConnectError("no route"))
        exporter = XraySpanExporter(endpoint=_ENDPOINT)
        try:
            result = exporter.export(spans)
        finally:
            exporter.shutdown()

    assert result is SpanExportResult.FAILURE


def test_export_after_shutdown_fails_quietly_without_a_request(caplog: pytest.LogCaptureFixture):
    """Post-shutdown export is an expected race (the provider can hand the
    processor a last batch), not an incident: no HTTP call, and nothing
    logged as an error — otherwise every clean worker exit prints a stack
    trace from the closed httpx client."""
    spans = _finished_spans()
    with respx.mock(base_url=_ENDPOINT, assert_all_called=False) as mock:
        route = mock.post(_TRACES_PATH).mock(return_value=httpx.Response(200, json={}))
        exporter = XraySpanExporter(endpoint=_ENDPOINT)
        exporter.shutdown()
        with caplog.at_level(logging.ERROR, logger="xray.otel"):
            result = exporter.export(spans)

    assert result is SpanExportResult.FAILURE
    assert route.call_count == 0
    assert caplog.records == []


def _emit_and_flush(provider: TracerProvider) -> None:
    tracer = provider.get_tracer("xray-py-test", "0.0.1")
    with tracer.start_as_current_span("agent.step"):
        pass
    provider.force_flush(timeout_millis=10_000)


def test_install_returns_the_provider_it_was_given():
    provider = TracerProvider()
    try:
        assert install(endpoint=_ENDPOINT, tracer_provider=provider) is provider
    finally:
        provider.shutdown()


def test_install_twice_for_the_same_endpoint_exports_each_span_once():
    """The guard is what keeps a worker that calls ``xray.attach`` per job from
    POSTing every span N times."""
    provider = TracerProvider()
    with respx.mock() as mock:
        route = mock.post(_ENDPOINT + _TRACES_PATH).mock(return_value=httpx.Response(200, json={}))
        install(endpoint=_ENDPOINT, tracer_provider=provider)
        install(endpoint=_ENDPOINT, tracer_provider=provider)
        try:
            _emit_and_flush(provider)
        finally:
            provider.shutdown()

    assert route.call_count == 1


def test_install_for_a_second_endpoint_adds_a_second_pipeline():
    """The guard is keyed by endpoint, not by "already installed" — a process
    fanning spans to two xray instances must reach both."""
    other = "http://other.test"
    provider = TracerProvider()
    with respx.mock() as mock:
        first = mock.post(_ENDPOINT + _TRACES_PATH).mock(return_value=httpx.Response(200, json={}))
        second = mock.post(other + _TRACES_PATH).mock(return_value=httpx.Response(200, json={}))
        install(endpoint=_ENDPOINT, tracer_provider=provider)
        install(endpoint=other, tracer_provider=provider)
        try:
            _emit_and_flush(provider)
        finally:
            provider.shutdown()

    assert first.call_count == 1
    assert second.call_count == 1


def test_install_wires_the_baggage_lift_so_exported_spans_carry_the_replay_id():
    provider = TracerProvider()
    with respx.mock() as mock:
        route = mock.post(_ENDPOINT + _TRACES_PATH).mock(return_value=httpx.Response(200, json={}))
        install(endpoint=_ENDPOINT, tracer_provider=provider)
        token = attach_replay_baggage(
            replay_id="rep-installed", conversation_hash=_HASH, modality="voice"
        )
        try:
            _emit_and_flush(provider)
        finally:
            context.detach(token)
            provider.shutdown()

    assert "rep-installed" in _raw_body(route).decode("utf-8")
