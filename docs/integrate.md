# Integrating xray into an existing LiveKit Agents worker

This is the canonical walkthrough. If you've got a LiveKit Agents
worker today and you want xray to record + replay its conversations,
read top-to-bottom and copy the code blocks.

You'll need:

- xray running. Latest image, mounted volume for `/data`. The
  reference compose snippet is at the bottom of this doc.
- LiveKit server **≥ v1.7** reachable from both the test driver and
  the agent worker (the xray SDK propagates the replay context via
  `participant.attributes`, added in 1.7).
- Python **3.10+** for the agent. The xray SDK runs on the same
  Python you ship your agent on; no version uplift required.

The example below is a real-world voice-service worker; the wiring
is identical for any LiveKit Agents codebase.

---

## 1. Install the SDK on the agent side

```bash
pip install xray-py[livekit]
```

The `[livekit]` extra pulls in `livekit` + `livekit-api`. Drop it if
you implement your own driver class.

Set `XRAY_OTLP_ENDPOINT` on the agent worker:

```bash
export XRAY_OTLP_ENDPOINT=http://xray:8080
```

xray accepts both OTLP/JSON (the SDK's default wire) and
OTLP/Protobuf (any stock OTEL exporter), so existing OTEL pipelines
work too — but `xray.attach` ships the JSON pipeline itself.

---

## 2. Wrap the worker entrypoint with `xray.attach`

```python
import xray
from livekit.agents import JobContext, WorkerOptions, cli, AutoSubscribe

async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    async with xray.attach(ctx, service_name="my-agent") as session:
        # `session` is None when no xray-tagged participant joined.
        # Inside the block, OTEL baggage carries:
        #   xray.replay.id, xray.conversation.id, xray.conversation.version, xray.modality
        # The bundled span processor lifts those onto every span at start.
        # On block exit, the tracer provider force-flushes so spans land
        # in xray before the worker shuts down.

        # Your existing strategy / pipeline runs here:
        await your_agent.run(ctx, session=session)


cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
```

Notes:

- `xray.attach` is an **async context manager**, not a decorator.
  Decorator wrappers break LiveKit Agents' multiprocessing
  forkserver pickling (the agent runs each job in a fresh
  subprocess that picks up the entrypoint by `__main__.entrypoint`
  lookup).
- Call `xray.attach` **after** `ctx.connect(...)` — before connect,
  `ctx.room.remote_participants` is empty and the bind has nothing
  to scan.
- The session is also reachable via `ctx.xray` inside the block, so
  helpers like `ctx.xray.turn(idx)` and `ctx.xray.record_tool_call(...)`
  work even if you've passed `ctx` around without `session`.

---

## 3. Emit recognized spans

xray persists spans under three vocabularies — `xray.*`,
OTel GenAI semconv (`gen_ai.*`), and Langfuse (`langfuse.*`).
Spans outside those namespaces are stored as raw spans but don't
extract into structured rows.

### Per-turn boundaries

Scope each agent turn with `session.turn(idx)`:

```python
async with session.turn(0):
    # ... process turn 0 ...
async with session.turn(1):
    # ... process turn 1 ...
```

The CM emits an `xray.turn` span which xray's vocabulary registry
extracts into a `replay_turns` row.

### Tool calls

```python
session.record_tool_call(
    "book_table",
    args_json='{"time": "7pm", "party_size": 2}',
    result_json='{"confirmation": "ABC123"}',
    latency_ms=350,
)
```

This emits a `gen_ai.tool` span which xray persists as a `tool_calls`
row. Useful inside an assertion:

```python
def confirms_booking(agent):
    return any(t.name == "book_table" and "ABC" in (t.result_json or "")
               for t in agent.tool_calls)
```

### Model usage

If your agent uses an OTel-instrumented LLM client (the
`opentelemetry-instrumentation-openai-v2` package, Langfuse, etc.),
the spans land in xray automatically. No xray-specific code required.

---

## 4. Write a test

```python
import asyncio
import xray
from xray.conversation import RecordedAudio
from xray.runtime.livekit import LiveKitDriver


async def main():
    conv = xray.Conversation(
        id="booking-happy-path",
        turns=[
            xray.Turn.agent(key="a-greeting"),
            xray.Turn.user(
                "Book a table for two at 7pm.",
                key="u-question",
                audio=RecordedAudio(path="/path/to/utterance.wav"),
            ),
            xray.Turn.agent(
                key="a-answer",
                assertion=lambda a: "confirmed" in a.transcript.lower(),
                assertion_name="confirms_booking",
            ),
        ],
    )

    driver = LiveKitDriver(
        url="ws://localhost:7880",
        api_key="devkey",
        api_secret="devsecret32charsminimumlengthxyz123",
        room=f"booking-test-{__import__('uuid').uuid4().hex[:6]}",
    )

    result = await xray.run(
        conversation=conv,
        runtime=driver,
        xray_url="http://localhost:8080",
        run_config=xray.RunConfig(model="gpt-4o", temperature=0.5),
    )
    print(f"replay: {result.url}")
    print(f"status: {result.status}")
    for a in result.assertions:
        print(f"  {a.name}: {a.status}")


asyncio.run(main())
```

`xray.run` is async — wrap in `asyncio.run` for sync test harnesses.
There is no sync `xray.run`; the previous one was a footgun in
already-running loops (pytest-asyncio, Jupyter, LiveKit Agents).

User-turn audio formats:

- `RecordedAudio(path=...)` — 48 kHz mono int16 WAV on disk.
- `TtsAudio()` — synthesized via OpenAI TTS at runtime
  (`OPENAI_API_KEY` required; the key stays in your process, never
  reaches xray).

For Cartesia / 11Labs / Deepgram, synthesize externally and pass the
output as `RecordedAudio` — multi-provider TTS Protocol is on the
v0.2 roadmap.

---

## 5. Read the result

`AgentResponse` (handed to per-turn assertions) carries the full
server-side view:

- `transcript` — published `rtc.Transcription` segments (your agent
  must publish them; see your provider's docs).
- `tool_calls` — `tuple[ToolCall]` of `gen_ai.tool` spans for this turn.
- `model_usage` — `tuple[ModelUsage]` of `gen_ai.usage.*` rollups.
- `stage_timings` — `dict[str, float]` of `xray.stage.*` durations.

`ReplayResult` (handed to the per-replay judge) carries the same view
across all turns plus the full transcript.

---

## 6. Run xray itself

Production-shape compose:

```yaml
services:
  xray:
    image: ghcr.io/xray-eval/xray:0.1.0
    restart: unless-stopped
    ports: ["8080:8080"]
    volumes: ["xray-data:/data"]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]

volumes:
  xray-data:
```

xray ships as a single Docker image. SQLite for storage. Inspector
UI at `http://localhost:8080`.

---

## What changed from earlier alphas

xray-py is at **v0.1.0** — clean cut from earlier alpha:

- `xray.run` is async-only. No more sync `run()` collision with
  running loops.
- `Turn.user(...)` + `Turn.agent(...)`. `expect_agent_turn` is gone.
- `LiveKitDriver` replaces `LiveKitRuntime`. The name now reflects
  what it is (a *user-side test driver*, not a LiveKit Agents
  runtime).
- `xray.attach(ctx)` async-CM replaces the `xray.trace.*` module +
  manual `bind_from_livekit_room` + manual baggage processor +
  manual exporter. One call.
- Replay context propagates via the JWT's `xray` attribute
  (LiveKit `participant.attributes` ≥ v1.7), not via participant
  metadata. No `can_update_own_metadata` grant required.
- Wire is snake_case end-to-end. `conversation_id`,
  `failure_reason`, `started_at`. Both OTLP/JSON and OTLP/Protobuf
  are accepted on the receiver.
- `RunConfig` is a typed dataclass (`model`, `temperature`, `extra`).
- `AgentResponse` is rich by default — assertions see tool_calls /
  model_usage / stage_timings without polling the server.
- Failure classification is typed-error-only. No more substring
  matching on `str(exception)`.
