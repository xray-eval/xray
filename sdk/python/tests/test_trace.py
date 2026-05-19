"""Trace helpers — baggage scoping for ``set_replay_context`` / ``turn`` /
``aturn`` and span-stamping for ``@stage``.

The InMemorySpanExporter is wired once per test so spans don't bleed
between cases; baggage is read directly from the OTEL context, which
naturally resets between tests because each test function uses its own
detach token.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

import pytest
from opentelemetry import baggage, context
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import set_tracer_provider

from xray import trace as xray_trace
from xray.errors import MissingReplayContextError
from xray.trace import (
    XRAY_CONVERSATION_ID,
    XRAY_CONVERSATION_VERSION,
    XRAY_MODALITY,
    XRAY_REPLAY_ID,
    XRAY_TURN_IDX,
    XRAY_TURN_KEY,
    astage,
    aturn,
    bind_from_livekit_room,
    detach,
    replay_context,
    set_replay_context,
    stage,
    turn,
)


@dataclass
class _StubRoom:
    metadata: str | None


# Module-level OTEL state — installed exactly once per pytest process.
# Setting a TracerProvider twice in one process is a no-op + warning, so
# we cache the exporter here instead of re-installing per-test.
_state: dict[str, InMemorySpanExporter] = {}


@pytest.fixture(autouse=True)
def _exporter() -> InMemorySpanExporter:
    if "exporter" not in _state:
        provider = TracerProvider()
        exporter = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        set_tracer_provider(provider)
        # The module cached its tracer at import time against the no-op
        # default provider — rebind so spans land in our exporter.
        xray_trace._tracer = provider.get_tracer("xray-py", "0.0.1")
        _state["exporter"] = exporter
    _state["exporter"].clear()
    return _state["exporter"]


def test_set_replay_context_attaches_baggage():
    token = set_replay_context("r-1", "c-1", "v-1")
    try:
        assert baggage.get_baggage(XRAY_REPLAY_ID) == "r-1"
        assert baggage.get_baggage(XRAY_CONVERSATION_ID) == "c-1"
        assert baggage.get_baggage(XRAY_CONVERSATION_VERSION) == "v-1"
        assert baggage.get_baggage(XRAY_MODALITY) == "voice"
    finally:
        detach(token)
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None


def test_replay_context_manager_detaches_on_exit():
    with replay_context("r-2", "c-2", "v-2"):
        assert baggage.get_baggage(XRAY_REPLAY_ID) == "r-2"
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None


def test_turn_attaches_idx_and_key():
    with turn(3, key="a3"):
        assert baggage.get_baggage(XRAY_TURN_IDX) == "3"
        assert baggage.get_baggage(XRAY_TURN_KEY) == "a3"
    assert baggage.get_baggage(XRAY_TURN_IDX) is None
    assert baggage.get_baggage(XRAY_TURN_KEY) is None


def test_turn_without_key_omits_turn_key_baggage():
    with turn(0):
        assert baggage.get_baggage(XRAY_TURN_IDX) == "0"
        assert baggage.get_baggage(XRAY_TURN_KEY) is None


def test_aturn_is_an_async_context_manager():
    async def _body():
        async with aturn(2, key="u2"):
            assert baggage.get_baggage(XRAY_TURN_IDX) == "2"
            assert baggage.get_baggage(XRAY_TURN_KEY) == "u2"
        assert baggage.get_baggage(XRAY_TURN_IDX) is None

    asyncio.run(_body())


def test_nested_turn_restores_outer_scope():
    with turn(0, key="u0"):
        assert baggage.get_baggage(XRAY_TURN_IDX) == "0"
        with turn(1, key="a0"):
            assert baggage.get_baggage(XRAY_TURN_IDX) == "1"
            assert baggage.get_baggage(XRAY_TURN_KEY) == "a0"
        assert baggage.get_baggage(XRAY_TURN_IDX) == "0"
        assert baggage.get_baggage(XRAY_TURN_KEY) == "u0"


def test_stage_decorator_emits_named_span_with_baggage(_exporter: InMemorySpanExporter) -> None:
    @stage("stt")
    def transcribe(x: int) -> int:
        return x * 2

    with replay_context("r-7", "c-7", "v-7"), turn(4, key="u4"):
        assert transcribe(3) == 6

    spans = _exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "xray.stage.stt"
    attrs = span.attributes or {}
    assert attrs[XRAY_REPLAY_ID] == "r-7"
    assert attrs[XRAY_CONVERSATION_ID] == "c-7"
    assert attrs[XRAY_TURN_IDX] == "4"
    assert attrs[XRAY_TURN_KEY] == "u4"


def test_stage_async_decorator(_exporter: InMemorySpanExporter) -> None:
    @astage("tts")
    async def synth(text: str) -> str:
        return text + "!"

    async def _body():
        with replay_context("r-8", "c-8", "v-8"):
            assert await synth("hi") == "hi!"

    asyncio.run(_body())
    spans = _exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "xray.stage.tts"
    attrs = spans[0].attributes or {}
    assert attrs[XRAY_REPLAY_ID] == "r-8"


def test_stage_records_exception_on_failure(_exporter: InMemorySpanExporter) -> None:
    @stage("stt")
    def boom() -> int:
        raise RuntimeError("nope")

    with pytest.raises(RuntimeError, match="nope"):
        boom()

    spans = _exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.status.status_code.name == "ERROR"
    # record_exception() adds an "exception" event on the span.
    assert any(ev.name == "exception" for ev in span.events)


def test_context_is_clean_between_tests():
    # Defensive check: prior tests should not have leaked any baggage
    # — the autouse exporter fixture clears spans, but baggage is a
    # property of the current context which we never installed.
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None
    assert context.get_current() is not None


def test_bind_from_livekit_room_populates_baggage():
    room = _StubRoom(
        metadata=json.dumps(
            {
                XRAY_REPLAY_ID: "rep-1",
                XRAY_CONVERSATION_ID: "conv-A",
                XRAY_CONVERSATION_VERSION: "v123",
                XRAY_MODALITY: "voice",
            }
        )
    )
    token = bind_from_livekit_room(room)
    try:
        assert baggage.get_baggage(XRAY_REPLAY_ID) == "rep-1"
        assert baggage.get_baggage(XRAY_CONVERSATION_ID) == "conv-A"
        assert baggage.get_baggage(XRAY_CONVERSATION_VERSION) == "v123"
        assert baggage.get_baggage(XRAY_MODALITY) == "voice"
    finally:
        detach(token)


def test_bind_from_livekit_room_defaults_modality_to_voice():
    room = _StubRoom(
        metadata=json.dumps(
            {
                XRAY_REPLAY_ID: "rep-1",
                XRAY_CONVERSATION_ID: "conv-A",
                XRAY_CONVERSATION_VERSION: "v123",
            }
        )
    )
    token = bind_from_livekit_room(room)
    try:
        assert baggage.get_baggage(XRAY_MODALITY) == "voice"
    finally:
        detach(token)


def test_bind_from_livekit_room_raises_on_empty_metadata():
    with pytest.raises(MissingReplayContextError):
        bind_from_livekit_room(_StubRoom(metadata=""))


def test_bind_from_livekit_room_raises_on_none_metadata():
    with pytest.raises(MissingReplayContextError):
        bind_from_livekit_room(_StubRoom(metadata=None))


def test_bind_from_livekit_room_raises_on_malformed_json():
    with pytest.raises(MissingReplayContextError):
        bind_from_livekit_room(_StubRoom(metadata="{not json"))


def test_bind_from_livekit_room_raises_on_missing_keys():
    with pytest.raises(MissingReplayContextError):
        bind_from_livekit_room(_StubRoom(metadata=json.dumps({XRAY_REPLAY_ID: "rep-1"})))
