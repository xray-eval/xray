from __future__ import annotations

import pytest

from xray import Conversation, Turn


def test_conversation_auto_versions_from_turn_structure():
    a = Conversation(id="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])
    b = Conversation(id="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])
    assert a.version == b.version


def test_conversation_version_changes_with_turn_text():
    a = Conversation(id="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])
    b = Conversation(id="x", turns=[Turn.user("hello", key="u0"), Turn.agent(key="a0")])
    assert a.version != b.version


def test_assertion_presence_changes_version():
    a = Conversation(id="x", turns=[Turn.user("hi"), Turn.agent(key="a0")])
    b = Conversation(
        id="x",
        turns=[Turn.user("hi"), Turn.agent(key="a0", assertion=lambda _: True)],
    )
    assert a.version != b.version


def test_explicit_version_wins_over_fingerprint():
    a = Conversation(id="x", turns=[Turn.user("hi")], version="pinned-v1")
    assert a.version == "pinned-v1"


def test_empty_conversation_rejected():
    with pytest.raises(ValueError):
        Conversation(id="x", turns=[])


def test_spec_payload_matches_wire_shape():
    c = Conversation(
        id="conv-A",
        title="hello",
        turns=[Turn.user("hi there", key="u0"), Turn.agent(key="a0")],
    )
    payload = c.to_spec_payload()
    assert payload["id"] == "conv-A"
    assert payload["version"] == c.version
    assert payload.get("title") == "hello"
    assert payload["turns"] == [
        {"role": "user", "text": "hi there", "key": "u0"},
        {"role": "agent", "key": "a0"},
    ]
