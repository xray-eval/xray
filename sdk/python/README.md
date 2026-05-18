# xray-py

Python SDK for [xray](https://github.com/xray-eval/xray) — replay/eval framework for LiveKit voice agents.

> **Alpha.** Wire and API surface can break between minor versions.

## Install

```bash
pip install xray-py[livekit]
```

The `[livekit]` extra pulls in the `livekit` Python client. Drop it if you implement your own runtime.

## Quickstart

```python
from xray import Conversation, Turn, expect_agent_turn, run
from xray.runtime.livekit import LiveKitRuntime

conv = Conversation(
    id="booking-happy-path",
    turns=[
        Turn.user("Hi, I'd like to book a table for two at 7pm.", key="u0"),
        expect_agent_turn(
            key="a0",
            assertion=lambda agent: "confirmed" in agent.transcript.lower(),
        ),
    ],
)

runtime = LiveKitRuntime(
    url="wss://your-project.livekit.cloud",
    api_key="...",  # from env
    api_secret="...",
    room="booking-test-room",
)

replay = run(
    conversation=conv,
    runtime=runtime,
    xray_url="http://localhost:8080",
    run_config={"model": "gpt-4o", "temperature": 0.5},
)
print(f"replay: http://localhost:8080/replays/{replay.id}")
```

## Three modules

- `xray.conversation` — `Conversation`, `Turn`, `expect_agent_turn` test-definition primitives.
- `xray.trace` — `@xray.trace.stage("stt")` / `@xray.trace.stage("tts")` OpenTelemetry decorators that propagate `xray.replay.id` from LiveKit room metadata via OTEL baggage.
- `xray.runtime` — pluggable `Runtime` ABC; `xray.runtime.livekit.LiveKitRuntime` is the v1 implementation.

See `examples/booking_happy_path.py` for a full example.

## How it wires to xray

1. `run(...)` POSTs the Conversation to `POST /v1/conversations` (idempotent).
2. `run(...)` POSTs a Replay to `POST /v1/replays` and gets back a `replay_id`.
3. The runtime joins the LiveKit room with `replay_id` in room metadata.
4. The dev's agent reads metadata, propagates it via OTEL baggage on every span.
5. xray's OTLP receiver routes spans by `xray.replay.id` and persists what it recognizes (xray.*, OTel GenAI semconv, Langfuse).
6. `run(...)` evaluates assertions + judge and PATCHes the Replay row with the result.

See `docs/SDK.md` and `docs/WIRE.md` in the main repo for the contract.
