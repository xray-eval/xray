"""Tests for ``SimulatedSipCall`` — the wire-shape of the ``sip.*``
attributes the driver projects onto its JWT to appear as an inbound SIP
participant."""

from __future__ import annotations

from types import MappingProxyType

import pytest

from xray import SimulatedSipCall
from xray.instrument import XRAY_ATTRIBUTE_KEY


def test_to_attributes_emits_each_named_field_with_canonical_key() -> None:
    """Each field maps to the docs-canonical attribute key, casing included.
    A typo in the key string here would silently desync the driver from a
    real SIP-gateway participant — assert every key verbatim."""
    sip = SimulatedSipCall(
        caller_phone="+15551234567",
        trunk_phone="+46790952746",
        call_id="abc-123",
        call_id_full="abc-123@trunk.example.com",
        call_status="active",
        rule_id="rule-7",
        trunk_id="trunk-9",
    )
    assert sip.to_attributes() == {
        "sip.phoneNumber": "+15551234567",
        "sip.trunkPhoneNumber": "+46790952746",
        "sip.callID": "abc-123",
        "sip.callIDFull": "abc-123@trunk.example.com",
        "sip.callStatus": "active",
        "sip.ruleID": "rule-7",
        "sip.trunkID": "trunk-9",
    }


def test_to_attributes_skips_unset_fields() -> None:
    sip = SimulatedSipCall(caller_phone="+15551234567")
    assert sip.to_attributes() == {"sip.phoneNumber": "+15551234567"}


def test_to_attributes_passes_extra_attrs_through_verbatim() -> None:
    """Keys outside the standard ``sip.*`` set ride through ``extra_attrs``
    untouched — same key, same value."""
    sip = SimulatedSipCall(
        trunk_phone="+46790952746",
        extra_attrs={
            "x-custom-header": "from-headers-to-attributes-map",
            "tenant.id": "acme-42",
        },
    )
    attrs = sip.to_attributes()
    assert attrs["x-custom-header"] == "from-headers-to-attributes-map"
    assert attrs["tenant.id"] == "acme-42"
    assert attrs["sip.trunkPhoneNumber"] == "+46790952746"


def test_named_field_wins_over_extra_attrs_collision() -> None:
    """A dev who passes the same key twice (named field + extra_attrs) gets
    the named-field value — the typed shape is the source of truth."""
    sip = SimulatedSipCall(
        caller_phone="+15551234567",
        extra_attrs={"sip.phoneNumber": "+19999999999"},
    )
    assert sip.to_attributes()["sip.phoneNumber"] == "+15551234567"


def test_empty_simulated_sip_call_rejected() -> None:
    """An empty SimulatedSipCall is a misuse — the dev meant
    ``simulated_sip=None`` for a non-SIP run."""
    with pytest.raises(ValueError, match="at least one attribute"):
        SimulatedSipCall()


def test_extra_attrs_with_reserved_xray_key_rejected() -> None:
    """extra_attrs must never carry the ``xray`` binding key. Allowing it would
    let the merge in mint_user_token overwrite the replay binding the agent
    reads to attribute its spans — silently rebinding the run to a forged
    context. Reject at construction, where the mistake is visible."""
    with pytest.raises(ValueError, match=XRAY_ATTRIBUTE_KEY):
        SimulatedSipCall(caller_phone="+15551234567", extra_attrs={XRAY_ATTRIBUTE_KEY: "forged"})


def test_extra_attrs_is_frozen_after_construction() -> None:
    """extra_attrs is stored as a read-only mapping so the reserved-key guard
    cannot be bypassed by mutating the dict after construction."""
    sip = SimulatedSipCall(caller_phone="+15551234567", extra_attrs={"x-custom-header": "v"})
    assert isinstance(sip.extra_attrs, MappingProxyType)


def test_only_extra_attrs_is_a_valid_configuration() -> None:
    """Setting just one ``extra_attrs`` entry (no named fields) is enough —
    the dev may want to simulate just a custom-header attribute."""
    sip = SimulatedSipCall(extra_attrs={"x-custom-header": "v"})
    assert sip.to_attributes() == {"x-custom-header": "v"}


def test_caller_phone_only_is_accepted() -> None:
    """Per the SDK decision (allow one): a single phone is a valid config."""
    sip = SimulatedSipCall(caller_phone="+15551234567")
    assert sip.to_attributes() == {"sip.phoneNumber": "+15551234567"}


def test_trunk_phone_only_is_accepted() -> None:
    sip = SimulatedSipCall(trunk_phone="+46790952746")
    assert sip.to_attributes() == {"sip.trunkPhoneNumber": "+46790952746"}
