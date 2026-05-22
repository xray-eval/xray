from __future__ import annotations

from pathlib import Path

import pytest

from xray import Conversation, Turn
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
    assert payload["turns"] == [
        {"role": "user", "text": "hi there", "key": "u0"},
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
