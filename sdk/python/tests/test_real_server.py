"""End-to-end SDK ↔ real-server integration test.

Boots the xray server as a `bun` subprocess against a temp DB, drives one
replay through `xray.run(...)` with a stub Runtime, and asserts the wire
contract holds end-to-end:

- POST /v1/replays (multipart) accepts the SDK's spec.
- The server returns a stable 64-char `conversation_hash` it computed.
- A second run with byte-identical turns reuses the same conversation row
  (validates `ensureConversation` last-write-wins).
- GET /v1/conversations/:hash returns the row.

Skipped automatically when ``bun`` isn't on PATH (e.g. CI that doesn't
install Bun) — runs locally on any dev machine.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from typing_extensions import override

from xray import Conversation, Turn, run
from xray.conversation import AgentResponse
from xray.runtime.base import Runtime, RuntimeResult

REPO_ROOT = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.skipif(
    shutil.which("bun") is None,
    reason="`bun` not on PATH; skip the real-server integration test.",
)


class StubRuntime(Runtime):
    """Drops the conversation through xray.run without touching LiveKit."""

    def __init__(self, num_turns: int) -> None:
        self._responses = [AgentResponse(transcript="") for _ in range(num_turns)]
        self.bound: dict[str, str] | None = None

    def bind(self, *, replay_id: str, conversation_hash: str) -> None:
        self.bound = {"replay_id": replay_id, "conversation_hash": conversation_hash}

    @override
    async def run(self, conversation: Conversation) -> RuntimeResult:
        return RuntimeResult(responses=self._responses)

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


async def test_run_against_real_server_returns_conversation_hash(xray_server: str):
    conv = Conversation(
        name="integration test",
        turns=[Turn.user("hello", key="u0"), Turn.agent(key="a0")],
    )
    runtime = StubRuntime(num_turns=len(conv.turns))

    result = await run(conversation=conv, runtime=runtime, xray_url=xray_server)

    assert len(result.conversation_hash) == 64
    assert result.name == "integration test"
    assert result.status == "completed"
    # Bind kwargs got propagated by the orchestrator.
    assert runtime.bound is not None
    assert runtime.bound["conversation_hash"] == result.conversation_hash


async def test_second_run_reuses_conversation_row(xray_server: str):
    conv1 = Conversation(
        name="first name",
        turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")],
    )
    conv2 = Conversation(
        name="renamed",  # name differs; hash should NOT
        turns=[Turn.user("hi", key="u0"), Turn.agent(key="a0")],
    )

    runtime1 = StubRuntime(num_turns=len(conv1.turns))
    runtime2 = StubRuntime(num_turns=len(conv2.turns))
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
