from __future__ import annotations

from pathlib import Path

import pytest

from xray import Assertion, Conversation, Judge, Turn
from xray.conversation import RecordedAudio, TtsAudio


def test_empty_conversation_rejected():
    with pytest.raises(ValueError):
        Conversation(name="x", turns=[])


def test_empty_name_rejected():
    with pytest.raises(ValueError):
        Conversation(name="", turns=[Turn.user("hi")])


def test_replay_spec_payload_matches_wire_shape():
    c = Conversation(
        name="My conv",
        turns=[Turn.user("hi there", key="u0"), Turn.agent(key="a0")],
    )
    payload = c.to_conversation_spec_payload()
    assert payload["name"] == "My conv"
    # A user turn with no explicit audio defaults to server-side TTS —
    # emitted explicitly so the server synthesizes exactly the turns the
    # wire declares. Agent turns never carry audio.
    assert payload["turns"] == [
        {"role": "user", "text": "hi there", "key": "u0", "audio": {"kind": "tts"}},
        {"role": "agent", "key": "a0"},
    ]
    # SDK does no hashing — server is the sole authority.
    assert "hash" not in payload


def test_replay_spec_payload_marks_recorded_audio_with_upload_key(tmp_path: Path):
    """RecordedAudio turns emit `{kind: "recorded", upload_key}` so the server
    can match each turn to its multipart file part."""
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"\x00\x01\x02\x03")
    c = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0", audio=RecordedAudio(path=str(wav))),
            Turn.agent(key="a0"),
        ],
    )
    payload = c.to_conversation_spec_payload()
    audio = payload["turns"][0].get("audio")
    assert audio == {"kind": "recorded", "upload_key": "audio_0"}


def test_replay_spec_payload_tts_audio_inline(tmp_path: Path):
    c = Conversation(
        name="x",
        turns=[Turn.user("hi", key="u0", audio=TtsAudio(voice_id="alloy"))],
    )
    payload = c.to_conversation_spec_payload()
    assert payload["turns"][0].get("audio") == {"kind": "tts", "voice_id": "alloy"}


def test_recorded_audio_uploads_yields_one_pair_per_recorded_turn(tmp_path: Path):
    wav1 = tmp_path / "u0.wav"
    wav1.write_bytes(b"\x00")
    wav2 = tmp_path / "u2.wav"
    wav2.write_bytes(b"\x01")
    c = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0", audio=RecordedAudio(path=str(wav1))),
            Turn.agent(key="a1"),
            Turn.user("again", key="u2", audio=RecordedAudio(path=str(wav2))),
        ],
    )
    uploads = c.recorded_audio_uploads()
    assert uploads == [("audio_0", str(wav1)), ("audio_2", str(wav2))]


def test_recorded_audio_uploads_skips_turns_without_recorded_audio():
    c = Conversation(
        name="x",
        turns=[
            Turn.user("hi", key="u0"),
            Turn.user("again", key="u1", audio=TtsAudio(voice_id="alloy")),
        ],
    )
    assert c.recorded_audio_uploads() == []


# ─── Assertion / Judge wire encoding ──────────────────────────────────


def test_assertion_contains_wire_includes_kind_text_and_case_insensitive_default():
    a = Assertion.contains("hello")
    assert a.to_wire() == {"kind": "contains", "text": "hello", "case_insensitive": True}


def test_assertion_contains_respects_case_insensitive_override():
    a = Assertion.contains("hello", case_insensitive=False)
    assert a.to_wire()["case_insensitive"] is False


def test_assertion_regex_wire_carries_pattern_and_flags():
    a = Assertion.regex(r"\d+", flags="i")
    assert a.to_wire() == {"kind": "regex", "pattern": r"\d+", "flags": "i"}


def test_assertion_tool_called_minimal_wire():
    a = Assertion.tool_called("reserve_table")
    assert a.to_wire() == {"kind": "tool_called", "name": "reserve_table"}


def test_assertion_tool_args_match_carries_args():
    a = Assertion.tool_args_match("reserve_table", {"party_size": 2})
    assert a.to_wire() == {
        "kind": "tool_args_match",
        "name": "reserve_table",
        "args": {"party_size": 2},
    }


def test_assertion_max_latency_ms_carries_integer():
    a = Assertion.max_latency_ms(2_000)
    assert a.to_wire() == {"kind": "max_latency_ms", "max_ms": 2_000}


def test_turn_assertions_round_trip_into_wire_payload():
    c = Conversation(
        name="x",
        turns=[
            Turn.user("book a table", key="u0"),
            Turn.agent(
                key="a0",
                assertions=(
                    Assertion.contains("confirmed"),
                    Assertion.max_latency_ms(2_000),
                ),
            ),
        ],
    )
    payload = c.to_conversation_spec_payload()
    agent_turn = payload["turns"][1]
    assert agent_turn.get("assertions") == [
        {"kind": "contains", "text": "confirmed", "case_insensitive": True},
        {"kind": "max_latency_ms", "max_ms": 2_000},
    ]


def test_turn_without_assertions_omits_the_key_from_wire_payload():
    c = Conversation(name="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])
    payload = c.to_conversation_spec_payload()
    assert "assertions" not in payload["turns"][0]
    assert "assertions" not in payload["turns"][1]


def test_judge_text_match_wire_includes_reference_and_default_pass_score():
    j = Judge.text_match("agent confirms booking")
    assert j.to_wire() == {
        "kind": "text_match",
        "reference": "agent confirms booking",
        "pass_score": 70,
    }


def test_judge_text_match_includes_rubric_when_set():
    j = Judge.text_match("ref", rubric="Penalize hedging.", pass_score=85)
    assert j.to_wire() == {
        "kind": "text_match",
        "reference": "ref",
        "pass_score": 85,
        "rubric": "Penalize hedging.",
    }


def test_conversation_judges_round_trip_into_wire_payload():
    c = Conversation(
        name="x",
        turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")],
        judges=(Judge.text_match("agent confirms", pass_score=80),),
    )
    payload = c.to_conversation_spec_payload()
    assert payload.get("judges") == [
        {"kind": "text_match", "reference": "agent confirms", "pass_score": 80}
    ]


def test_conversation_without_judges_omits_the_key_from_wire_payload():
    c = Conversation(name="x", turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")])
    payload = c.to_conversation_spec_payload()
    assert "judges" not in payload
