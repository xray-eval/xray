"""Tests for ``mint_user_token`` — the shared JWT minter for both the
scripted and live LiveKit runtimes."""

from __future__ import annotations

from unittest.mock import MagicMock

from xray import SimulatedSipCall
from xray.instrument import XRAY_ATTRIBUTE_KEY, encode_attribute
from xray.runtime.livekit import mint_user_token


def _fake_lk_api() -> tuple[MagicMock, MagicMock]:
    """Build a MagicMock lk_api whose AccessToken returns a chainable
    builder — every with_* returns self so the test can inspect all calls
    in order on one mock."""
    api = MagicMock(name="lk_api")
    token = MagicMock(name="AccessToken")
    token.with_identity.return_value = token
    token.with_grants.return_value = token
    token.with_attributes.return_value = token
    token.with_kind.return_value = token
    token.to_jwt.return_value = "fake-jwt"
    api.AccessToken = MagicMock(return_value=token)
    api.VideoGrants = MagicMock()
    return api, token


def test_without_simulated_sip_no_kind_call_only_xray_attribute() -> None:
    """The default (non-SIP) path mints a JWT with the single ``xray``
    attribute and no ``with_kind`` call."""
    api, token = _fake_lk_api()
    jwt = mint_user_token(
        api,
        api_key="ak",
        api_secret="sk",
        room="r1",
        identity="xray-driver",
        replay_id="rep-1",
        conversation_hash="a" * 64,
    )
    assert jwt == "fake-jwt"
    token.with_identity.assert_called_once_with("xray-driver")
    args, _ = token.with_attributes.call_args
    attrs = args[0]
    assert set(attrs.keys()) == {XRAY_ATTRIBUTE_KEY}
    token.with_kind.assert_not_called()


def test_simulated_sip_sets_kind_sip_and_merges_attrs() -> None:
    """With ``simulated_sip`` set, the JWT additionally declares
    ``kind=sip`` and merges every ``sip.*`` attribute alongside the
    untouched ``xray`` blob."""
    api, token = _fake_lk_api()
    sip = SimulatedSipCall(
        caller_phone="+15551234567",
        trunk_phone="+46790952746",
        call_id="abc-123",
        call_status="active",
    )
    mint_user_token(
        api,
        api_key="ak",
        api_secret="sk",
        room="r1",
        identity="xray-driver",
        replay_id="rep-1",
        conversation_hash="a" * 64,
        simulated_sip=sip,
    )
    token.with_kind.assert_called_once_with("sip")

    args, _ = token.with_attributes.call_args
    attrs = args[0]
    # The sip.* merge must leave the replay binding byte-for-byte intact —
    # check the VALUE, not just the key's presence (a clobber preserves the key).
    expected = encode_attribute(replay_id="rep-1", conversation_hash="a" * 64)
    assert attrs[XRAY_ATTRIBUTE_KEY] == expected[XRAY_ATTRIBUTE_KEY]
    assert attrs["sip.phoneNumber"] == "+15551234567"
    assert attrs["sip.trunkPhoneNumber"] == "+46790952746"
    assert attrs["sip.callID"] == "abc-123"
    assert attrs["sip.callStatus"] == "active"
