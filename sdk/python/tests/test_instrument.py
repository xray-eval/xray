"""Tests for ``xray.attach`` and the agent-side binding it performs.

The LiveKit ``JobContext`` is duck-typed by ``xray.instrument`` (only
``.room.remote_participants`` plus ``on``/``off`` are read), so the fakes
here implement those Protocols directly — no ``livekit`` import, no
network, no ``Any``.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass, field

import pytest
from opentelemetry import baggage
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from typing_extensions import override

import xray.instrument as instrument_mod
from xray.instrument import (
    ReplayContext,
    XraySession,
    _HasAttributes,
    _HasRemoteParticipants,
    _parse_xray_attribute,
    _wait_for_replay_context,
    attach,
    encode_attribute,
)
from xray.otel import XRAY_MODALITY, XRAY_REPLAY_ID, XRAY_TURN_IDX, XRAY_TURN_KEY

_HASH = "a" * 64
_EVENT = "participant_attributes_changed"


@dataclass
class _FakeParticipant:
    """Matches ``_HasAttributes`` — the only shape the SDK reads off a
    ``livekit.rtc.RemoteParticipant``."""

    identity: str
    attributes: dict[str, str]


def _bound_participant(
    identity: str = "xray-driver",
    *,
    replay_id: str = "rep-1",
    modality: str = "voice",
) -> _FakeParticipant:
    return _FakeParticipant(
        identity=identity,
        attributes=encode_attribute(
            replay_id=replay_id, conversation_hash=_HASH, modality=modality
        ),
    )


class _FakeRoom:
    """Matches ``_HasRemoteParticipants``; records listener add/remove so a
    leaked handler is visible to the test."""

    def __init__(self, participants: dict[str, _HasAttributes] | None = None) -> None:
        self.remote_participants: dict[str, _HasAttributes] = dict(participants or {})
        self.handlers: dict[str, list[Callable[..., object]]] = {}

    def on(self, event: str, callback: Callable[..., object]) -> object:
        self.handlers.setdefault(event, []).append(callback)
        return callback

    def off(self, event: str, callback: Callable[..., object]) -> object:
        self.handlers.get(event, []).remove(callback)
        return callback

    def emit(self, event: str, *args: object) -> None:
        for callback in list(self.handlers.get(event, [])):
            callback(*args)

    def listener_count(self, event: str) -> int:
        return len(self.handlers.get(event, []))


@dataclass
class _FakeJobContext:
    """Matches ``_HasRoom``. Annotated with the Protocol (not ``_FakeRoom``)
    because Protocol attributes match invariantly."""

    room: _HasRemoteParticipants


class _RecordingProvider(TracerProvider):
    """A real provider that also records ``force_flush`` calls — the flush is
    what keeps the last spans from dying with the worker."""

    def __init__(self) -> None:
        super().__init__()
        self.flush_timeouts: list[int] = []

    @override
    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        self.flush_timeouts.append(timeout_millis)
        return super().force_flush(timeout_millis)


@dataclass
class _InstallSpy:
    """Stand-in for ``xray.otel.install`` so ``attach`` never touches the
    process-global tracer provider."""

    provider: _RecordingProvider
    endpoints: list[str] = field(default_factory=list[str])

    def __call__(self, *, endpoint: str) -> TracerProvider:
        self.endpoints.append(endpoint)
        return self.provider


def _patch_install(monkeypatch: pytest.MonkeyPatch) -> _InstallSpy:
    spy = _InstallSpy(provider=_RecordingProvider())
    monkeypatch.setattr(instrument_mod, "install_otel", spy)
    monkeypatch.delenv("XRAY_OTLP_ENDPOINT", raising=False)
    return spy


# --- _parse_xray_attribute -------------------------------------------------


def test_parse_xray_attribute_round_trips_the_encoded_blob():
    parsed = _parse_xray_attribute(encode_attribute(replay_id="rep-1", conversation_hash=_HASH))
    assert parsed == ReplayContext(replay_id="rep-1", conversation_hash=_HASH, modality="voice")


def test_parse_xray_attribute_keeps_a_non_default_modality():
    attrs = encode_attribute(replay_id="rep-1", conversation_hash=_HASH, modality="text")
    parsed = _parse_xray_attribute(attrs)
    assert parsed is not None
    assert parsed.modality == "text"


def test_parse_xray_attribute_defaults_modality_when_the_blob_omits_it():
    """Older drivers minted the blob without `modality`; a missing key is a
    voice run, not a parse failure."""
    raw = json.dumps({"replay_id": "rep-1", "conversation_hash": _HASH})
    parsed = _parse_xray_attribute({"xray": raw})
    assert parsed == ReplayContext(replay_id="rep-1", conversation_hash=_HASH, modality="voice")


@pytest.mark.parametrize(
    "attributes",
    [
        {},
        {"xray": ""},
        {"sip.callID": "abc-123"},
        {"xray": "{not json"},
        {"xray": "null"},
        {"xray": json.dumps({"conversation_hash": _HASH})},
        {"xray": json.dumps({"replay_id": "rep-1"})},
        {"xray": json.dumps({"replay_id": "", "conversation_hash": _HASH})},
        {"xray": json.dumps({"replay_id": "rep-1", "conversation_hash": ""})},
    ],
    ids=[
        "no-attributes",
        "empty-value",
        "unrelated-attribute",
        "malformed-json",
        "json-null",
        "missing-replay-id",
        "missing-conversation-hash",
        "empty-replay-id",
        "empty-conversation-hash",
    ],
)
def test_parse_xray_attribute_returns_none_for_anything_unusable(attributes: dict[str, str]):
    """Every rejection must be a ``None``, never a raise: this runs inside the
    dev's entrypoint, and a throw here takes down a production agent that
    happens to carry an unrelated attribute."""
    assert _parse_xray_attribute(attributes) is None


# --- _wait_for_replay_context ---------------------------------------------


async def test_wait_scans_every_participant_already_in_the_room():
    room = _FakeRoom(
        {
            "sip-caller": _FakeParticipant(identity="sip-caller", attributes={"sip.callID": "x"}),
            "xray-driver": _bound_participant(),
        }
    )
    found = await _wait_for_replay_context(_FakeJobContext(room=room), 1.0)
    assert found == ReplayContext(replay_id="rep-1", conversation_hash=_HASH, modality="voice")
    assert room.listener_count(_EVENT) == 0


async def test_wait_resolves_from_an_attributes_changed_event():
    """The driver may set the attribute after the agent joins, so the initial
    scan can legitimately come up empty."""
    room = _FakeRoom({"late": _FakeParticipant(identity="late", attributes={})})
    task = asyncio.create_task(_wait_for_replay_context(_FakeJobContext(room=room), 5.0))
    await asyncio.sleep(0)
    participant = _bound_participant("late", replay_id="rep-late")
    room.emit(_EVENT, {"xray": "changed"}, participant)

    found = await task
    assert found is not None
    assert found.replay_id == "rep-late"
    assert room.listener_count(_EVENT) == 0


async def test_wait_resolves_when_the_participant_is_the_events_first_argument():
    """LiveKit's argument order for this event varies across versions — the
    participant may arrive alone."""
    room = _FakeRoom()
    task = asyncio.create_task(_wait_for_replay_context(_FakeJobContext(room=room), 5.0))
    await asyncio.sleep(0)
    room.emit(_EVENT, _bound_participant(replay_id="rep-first-arg"))

    found = await task
    assert found is not None
    assert found.replay_id == "rep-first-arg"


async def test_wait_ignores_event_payloads_that_are_not_participants():
    room = _FakeRoom()
    task = asyncio.create_task(_wait_for_replay_context(_FakeJobContext(room=room), 0.2))
    await asyncio.sleep(0)
    room.emit(_EVENT, {"xray": "just-a-dict"}, None)

    assert await task is None


async def test_wait_times_out_to_none_and_unregisters_its_listener():
    """No xray in front of the agent is the production case: bind must give up
    and leave the room exactly as it found it."""
    room = _FakeRoom({"human": _FakeParticipant(identity="human", attributes={})})
    found = await _wait_for_replay_context(_FakeJobContext(room=room), 0.05)
    assert found is None
    assert room.listener_count(_EVENT) == 0


# --- attach ----------------------------------------------------------------


async def test_attach_yields_a_session_bound_to_the_participants_replay(
    monkeypatch: pytest.MonkeyPatch,
):
    spy = _patch_install(monkeypatch)
    room = _FakeRoom({"xray-driver": _bound_participant()})
    async with attach(_FakeJobContext(room=room), endpoint="http://xray.test") as session:
        assert session is not None
        assert session.replay_id == "rep-1"
        assert session.conversation_hash == _HASH
        assert session.modality == "voice"
        assert baggage.get_baggage(XRAY_REPLAY_ID) == "rep-1"
        assert baggage.get_baggage(XRAY_MODALITY) == "voice"

    assert spy.endpoints == ["http://xray.test"]
    # Baggage is per-task state — leaving it attached would tag every later
    # job in this worker process with a finished replay's id.
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None


async def test_attach_force_flushes_the_provider_on_exit(monkeypatch: pytest.MonkeyPatch):
    """BatchSpanProcessor holds spans for seconds; a worker that exits without
    flushing loses the tail of every replay."""
    spy = _patch_install(monkeypatch)
    room = _FakeRoom({"xray-driver": _bound_participant()})
    async with attach(_FakeJobContext(room=room), endpoint="http://xray.test") as session:
        assert session is not None
        assert spy.provider.flush_timeouts == []

    assert spy.provider.flush_timeouts == [10_000]


async def test_attach_flushes_even_when_the_body_raises(monkeypatch: pytest.MonkeyPatch):
    spy = _patch_install(monkeypatch)
    room = _FakeRoom({"xray-driver": _bound_participant()})
    with pytest.raises(RuntimeError, match="agent blew up"):
        async with attach(_FakeJobContext(room=room), endpoint="http://xray.test"):
            raise RuntimeError("agent blew up")

    assert spy.provider.flush_timeouts == [10_000]
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None


async def test_attach_prefers_an_explicit_endpoint_over_the_env_var(
    monkeypatch: pytest.MonkeyPatch,
):
    spy = _patch_install(monkeypatch)
    monkeypatch.setenv("XRAY_OTLP_ENDPOINT", "http://from-env.test")
    room = _FakeRoom({"xray-driver": _bound_participant()})
    async with attach(_FakeJobContext(room=room), endpoint="http://explicit.test"):
        pass

    assert spy.endpoints == ["http://explicit.test"]


async def test_attach_falls_back_to_the_env_var_endpoint(monkeypatch: pytest.MonkeyPatch):
    spy = _patch_install(monkeypatch)
    monkeypatch.setenv("XRAY_OTLP_ENDPOINT", "http://from-env.test")
    room = _FakeRoom({"xray-driver": _bound_participant()})
    async with attach(_FakeJobContext(room=room)) as session:
        assert session is not None

    assert spy.endpoints == ["http://from-env.test"]


async def test_attach_without_an_endpoint_still_binds_baggage_but_yields_no_session(
    monkeypatch: pytest.MonkeyPatch,
):
    """No OTLP endpoint configured means no pipeline to hand a session — but
    the replay context still rides on baggage for any exporter the dev
    already wired up themselves."""
    spy = _patch_install(monkeypatch)
    room = _FakeRoom({"xray-driver": _bound_participant()})
    async with attach(_FakeJobContext(room=room)) as session:
        assert session is None
        assert baggage.get_baggage(XRAY_REPLAY_ID) == "rep-1"

    assert spy.endpoints == []
    assert baggage.get_baggage(XRAY_REPLAY_ID) is None


async def test_attach_runs_the_body_unbound_when_no_participant_carries_the_attribute(
    monkeypatch: pytest.MonkeyPatch,
):
    """This is the production path: the same entrypoint runs with no xray in
    front of it, and must not bind anything."""
    _patch_install(monkeypatch)
    room = _FakeRoom({"human": _FakeParticipant(identity="human", attributes={})})
    ran = False
    async with attach(
        _FakeJobContext(room=room), endpoint="http://xray.test", bind_timeout_s=0.05
    ) as session:
        ran = True
        assert session is None
        assert baggage.get_baggage(XRAY_REPLAY_ID) is None

    assert ran


# --- XraySession.turn ------------------------------------------------------


def _session_with_exporter() -> tuple[XraySession, InMemorySpanExporter]:
    provider = TracerProvider()
    memory = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    session = XraySession(
        ReplayContext(replay_id="rep-1", conversation_hash=_HASH, modality="voice"),
        provider,
    )
    # The session's tracer comes from the global provider at construction;
    # rebind it to this test's provider so emitted spans are observable.
    session._tracer = provider.get_tracer("xray-py", "0.0.1")
    return session, memory


async def test_turn_scopes_the_turn_index_on_baggage_and_restores_it():
    session, _ = _session_with_exporter()
    async with session.turn(2):
        assert baggage.get_baggage(XRAY_TURN_IDX) == "2"
        assert baggage.get_baggage(XRAY_TURN_KEY) is None
    assert baggage.get_baggage(XRAY_TURN_IDX) is None


async def test_turn_scopes_the_turn_key_when_given():
    session, _ = _session_with_exporter()
    async with session.turn(3, key="a1"):
        assert baggage.get_baggage(XRAY_TURN_KEY) == "a1"
    assert baggage.get_baggage(XRAY_TURN_KEY) is None


async def test_turn_emits_one_agent_side_xray_turn_span():
    """The server's vocabulary registry persists this span as the
    ``replay_turns`` row for the turn."""
    session, memory = _session_with_exporter()
    async with session.turn(1, key="a0"):
        await asyncio.sleep(0.01)

    spans = [s for s in memory.get_finished_spans() if s.name == "xray.turn"]
    assert len(spans) == 1
    attrs = spans[0].attributes or {}
    assert attrs.get("xray.turn.idx") == 1
    assert attrs.get("xray.turn.role") == "agent"
    assert attrs.get("xray.turn.key") == "a0"
    duration = attrs.get("xray.turn.duration_ms")
    assert isinstance(duration, int)
    assert duration >= 10


async def test_turn_without_a_key_omits_the_key_attribute():
    session, memory = _session_with_exporter()
    async with session.turn(0):
        pass

    attrs = memory.get_finished_spans()[0].attributes or {}
    assert "xray.turn.key" not in attrs


async def test_turn_records_its_duration_even_when_the_body_raises():
    session, memory = _session_with_exporter()
    with pytest.raises(RuntimeError, match="tool exploded"):
        async with session.turn(0):
            raise RuntimeError("tool exploded")

    attrs = memory.get_finished_spans()[0].attributes or {}
    assert "xray.turn.duration_ms" in attrs
    assert baggage.get_baggage(XRAY_TURN_IDX) is None
