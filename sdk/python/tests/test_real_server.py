"""End-to-end SDK ↔ real-server integration test.

Boots the xray server as a `bun` subprocess against a temp DB, drives one
replay through `xray.run(...)` with a stub Runtime that synthesizes a
minimal stereo WAV mixdown, and asserts the analyze chain runs end-to-end
through transcription + metrics + evaluation, surfacing the verdict on
the SSE stream as `evaluation_complete`.

Requires both:
- ``bun`` on PATH (the server is a `bun` subprocess);
- ``OPENAI_API_KEY`` in env (Whisper runs server-side during analyze).

Skipped automatically when either is missing — runs locally as a real
smoke test when both are present.
"""

from __future__ import annotations

import asyncio
import math
import os
import shutil
import socket
import struct
import subprocess
import time
import wave
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from typing_extensions import override

from xray import Conversation, Turn, run
from xray.conversation import AgentResponse
from xray.runtime.base import Runtime, RuntimeResult

REPO_ROOT = Path(__file__).resolve().parents[3]

pytestmark = [
    pytest.mark.skipif(
        shutil.which("bun") is None,
        reason="`bun` not on PATH; skip the real-server integration test.",
    ),
    pytest.mark.skipif(
        os.environ.get("OPENAI_API_KEY") in (None, ""),
        reason="OPENAI_API_KEY not set; server-side Whisper requires it.",
    ),
]


def _make_stereo_wav(path: Path, *, sample_rate: int = 48000, seconds: float = 1.0) -> None:
    """Write a 2-channel 48kHz int16 WAV with a 440Hz sine on left (user)
    in the first half and on right (agent) in the second half. Loud enough
    that the server's VAD produces two voiced turns — that's the minimum
    fixture for the analyze chain to land non-empty `replay_turns`."""
    n = int(sample_rate * seconds)
    half = n // 2
    samples: list[tuple[int, int]] = []
    amplitude = 16000
    for i in range(n):
        t = i / sample_rate
        s = int(amplitude * math.sin(2 * math.pi * 440 * t))
        if i < half:
            samples.append((s, 0))  # user channel
        else:
            samples.append((0, s))  # agent channel
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        frames = b"".join(struct.pack("<hh", l, r) for (l, r) in samples)
        wf.writeframes(frames)


class StubRuntime(Runtime):
    """Drops the conversation through xray.run without touching LiveKit,
    but produces a real stereo WAV mixdown so the server's analyze chain
    can run."""

    def __init__(self, num_turns: int, audio_path: Path) -> None:
        self._responses = [AgentResponse(transcript="") for _ in range(num_turns)]
        self._audio_path = audio_path
        self.bound: dict[str, str] | None = None

    def bind(self, *, replay_id: str, conversation_hash: str) -> None:
        self.bound = {"replay_id": replay_id, "conversation_hash": conversation_hash}

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        _make_stereo_wav(self._audio_path)
        return RuntimeResult(responses=self._responses, full_audio_path=str(self._audio_path))

    @override
    async def aclose(self) -> None:
        return None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _wait_for_healthz(url: str, timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    async with httpx.AsyncClient(timeout=1.0) as client:
        while time.monotonic() < deadline:
            try:
                r = await client.get(f"{url}/healthz")
                if r.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.2)
    raise TimeoutError(f"xray server at {url} never became healthy within {timeout_s}s")


@pytest.fixture
async def xray_server(tmp_path: Path) -> AsyncIterator[str]:
    port = _free_port()
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    env = dict(os.environ)
    env.update(
        {
            "PORT": str(port),
            "XRAY_DATA_DIR": str(data_dir),
            "XRAY_AUDIO_ROOT": str(tmp_path / "audio"),
        }
    )
    proc = subprocess.Popen(
        ["bun", "src/server/main.ts"],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        await _wait_for_healthz(base_url)
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()


async def test_run_against_real_server_returns_conversation_hash(
    xray_server: str, tmp_path: Path
):
    conv = Conversation(
        name="integration test",
        turns=[Turn.user("hello", key="u0"), Turn.agent(key="a0")],
    )
    runtime = StubRuntime(num_turns=len(conv.turns), audio_path=tmp_path / "mix-1.wav")

    result = await run(conversation=conv, runtime=runtime, xray_url=xray_server)

    assert len(result.conversation_hash) == 64
    # Spec 0001 reshape: ReplayResult no longer carries name/status — the
    # SDK returns the server's evaluation verdict. `passed` is always true
    # for a no-assertions, no-judges conversation (vacuously).
    assert result.passed is True
    assert runtime.bound is not None
    assert runtime.bound["conversation_hash"] == result.conversation_hash


async def test_second_run_reuses_conversation_row(xray_server: str, tmp_path: Path):
    conv1 = Conversation(
        name="first name",
        turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")],
    )
    conv2 = Conversation(
        name="renamed",  # name differs; hash should NOT
        turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")],
    )

    runtime1 = StubRuntime(num_turns=len(conv1.turns), audio_path=tmp_path / "mix-2a.wav")
    runtime2 = StubRuntime(num_turns=len(conv2.turns), audio_path=tmp_path / "mix-2b.wav")
    result1 = await run(conversation=conv1, runtime=runtime1, xray_url=xray_server)
    result2 = await run(conversation=conv2, runtime=runtime2, xray_url=xray_server)

    # Same turn structure ⇒ same conversation hash, regardless of name.
    assert result1.conversation_hash == result2.conversation_hash

    async with httpx.AsyncClient(base_url=xray_server, timeout=5.0) as client:
        list_resp = await client.get("/v1/conversations")
        list_resp.raise_for_status()
        items = list_resp.json()["items"]
        assert len(items) == 1
        assert items[0]["hash"] == result1.conversation_hash
        assert items[0]["name"] == "renamed"
        assert items[0]["replays"] == 2

        detail_resp = await client.get(f"/v1/conversations/{result1.conversation_hash}/replays")
        detail_resp.raise_for_status()
        replays = detail_resp.json()["items"]
        assert len(replays) == 2
        for r in replays:
            assert r["conversation_hash"] == result1.conversation_hash
