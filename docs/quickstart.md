---
title: Quick start
---

# Quick start

Zero to your first replay in about five minutes. Your first test needs **no
changes to your agent's code**.

You need three things: Docker, Python 3.10 or newer, and a running LiveKit Agents
worker (the voice agent you want to test).

## 1. Start xray

```bash
docker run -v ./data:/data -p 127.0.0.1:8080:8080 \
  -e OPENAI_API_KEY=sk-your-key \
  ghcr.io/xray-eval/xray:latest
```

Open [http://localhost:8080](http://localhost:8080). That is the inspector. Every
run shows up there.

xray uses `OPENAI_API_KEY` to transcribe the recorded audio. It is the only
credential the server needs to get you started.

## 2. Install the SDK

```bash
pip install "xray-py[livekit]"
```

## 3. Write and run your first test

```python
import asyncio
import xray
from xray import Assertion
from xray.runtime.livekit import LiveKitRuntime

conv = xray.Conversation(
    name="opening-hours",
    turns=[
        xray.Turn.user("Hi, are you open today?"),
        xray.Turn.agent(assertions=(Assertion.contains("open"),)),
    ],
)

driver = LiveKitRuntime(
    url="ws://localhost:7880",
    api_key="devkey",
    api_secret="devsecret32charsminimumlengthxyz123",
    room="quickstart",
)

async def main():
    result = await xray.run(conversation=conv, runtime=driver)
    assert result.passed, xray.format_failures(result)

asyncio.run(main())
```

That is the whole loop. xray joins your LiveKit room as the user, speaks the user
line, records your agent's reply, transcribes it, and checks the assertion.

Swap in your own LiveKit URL and keys, and change the assertion to match what your
agent says.

Your agent did not need any xray code. xray records it from the outside, by
listening in the room.

The user turn has no audio file, so xray synthesizes the speech for you. To use a
recording instead, pass `audio=RecordedAudio(path="utterance.wav")`.

## 4. Inspect the run

Open [http://localhost:8080](http://localhost:8080). Click the run to replay the
audio, read every turn, and see the timings.

## Go further: check tool calls and model usage

Want to assert that your agent called a tool, or check its time-to-first-token?
Those facts live in your agent's traces, not its audio. So xray needs your agent
to send them. This takes two small additions.

First, wrap your agent's entrypoint body in `xray.attach`:

```python
import xray
from livekit.agents import JobContext

async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    async with xray.attach(ctx, service_name="my-agent"):
        await your_agent.run(ctx)  # your existing agent code, unchanged
```

Second, tell the SDK where to send the traces. Set this in the shell where you
start your agent worker:

```bash
export XRAY_OTLP_ENDPOINT=http://localhost:8080
```

Use the same address you opened in step 1. If your agent runs inside the same
Docker network as xray, use the service name instead, like `http://xray:8080`.

Now tool and model assertions work:

```python
xray.Turn.agent(assertions=(
    Assertion.tool_called("reserve_table"),
    Assertion.max_ttft_ms(800),
))
```

## Next steps

- [Integrate](./integrate.md): the full walkthrough, with audio files, judges, and CI.
- [Python SDK](./sdk-python.md): every `Conversation`, `Assertion`, and `Judge` option.
- [Wire contract](./wire-contract.md): the spans your agent emits, and how your existing OpenTelemetry setup plugs in.
