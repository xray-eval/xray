---
layout: default
title: Home
nav_order: 1
---

# xray docs

**xray** is an open-source, self-hosted replay/eval framework for LiveKit
voice agents. You author a conversation in Python, run it against your agent,
and inspect every turn — audio, transcripts, tool calls, model usage, timings,
and pass/fail verdicts. One Docker image, one SQLite file, one Python SDK. No
accounts, no telemetry, no external database.

```bash
docker run -v ./data:/data -p 127.0.0.1:8080:8080 ghcr.io/xray-eval/xray:latest
# open http://localhost:8080  ·  API reference at /docs
pip install "xray-py[livekit]"
```

## Where to go

| Doc | Read it when |
|---|---|
| [Architecture](./architecture.md) | You want the mental model: the three processes, the two write paths, the analyze chain, and storage. |
| [Integrate](./integrate.md) | You have a LiveKit Agents worker and want xray to record + evaluate it. The end-to-end walkthrough. |
| [Python SDK](./sdk-python.md) | The authoritative `xray-py` reference: `Conversation` / `Turn` / `Assertion` / `Judge`, `run` / `run_live`, `attach`, the runtimes. |
| [Wire contract](./wire-contract.md) | You're checking what your agent's OTLP spans must look like to be recognized. |

The live API reference (OpenAPI 3.1, rendered by Scalar) is at `/docs` on any
running instance.

## How it fits together

1. **Author** a `Conversation` — user turns, per-turn `Assertion`s, and an
   optional conversation-level `Judge` — in Python.
2. **Run** it with `xray.run(...)`. The SDK joins your LiveKit room as a
   user-side participant, plays the user audio, captures the agent's audio +
   transcript, and uploads a stereo WAV.
3. Your agent emits **OpenTelemetry spans** during the run; xray's OTLP
   receiver routes them by `xray.replay.id` and extracts tool calls + model
   usage.
4. The server **analyzes** the recording (VAD → per-turn transcription →
   metrics → assertions + judges) and returns a `ReplayResult`.
5. **Inspect** and **compare** runs in the UI.

> **Alpha.** The wire and SDK API can break between minor versions. Upgrading
> wipes data — delete `/data/xray.db` before starting a new container.
