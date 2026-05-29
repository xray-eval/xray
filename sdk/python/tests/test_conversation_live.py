"""Tests for the ``live`` flag on :class:`xray.Conversation`."""

from __future__ import annotations

import pytest

from xray import Conversation, Turn


def test_live_conversation_allows_empty_turns():
    conv = Conversation(name="live-session", turns=[], live=True)
    assert conv.live is True
    assert conv.turns == []


def test_non_live_empty_turns_still_rejected():
    with pytest.raises(ValueError, match="at least one turn"):
        Conversation(name="scripted", turns=[])


def test_live_spec_payload_carries_live_true_and_empty_turns():
    conv = Conversation(name="live-session", turns=[], live=True)
    spec = conv.to_conversation_spec_payload()
    assert spec["name"] == "live-session"
    assert spec["turns"] == []
    assert spec.get("live") is True


def test_non_live_spec_payload_omits_live_key():
    conv = Conversation(name="scripted", turns=[Turn.user("hi")])
    spec = conv.to_conversation_spec_payload()
    # Non-live conversations stay byte-identical on the wire — no `live` key,
    # so their server-side hash is unchanged by this feature.
    assert "live" not in spec


def test_live_default_is_false():
    conv = Conversation(name="scripted", turns=[Turn.user("hi")])
    assert conv.live is False
