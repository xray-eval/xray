# xray + LiveKit voice agent — minimal example

Self-contained `docker compose` stack: **xray**, a **LiveKit** server, and
a **minimal Gemini Live voice agent**. A pytest driver runs one Replay
end-to-end to prove the wiring.

```
.
├── compose.yaml           ← 4 services: livekit, xray, agent, driver(profile:test)
├── .env.example           ← only GEMINI_API_KEY required
├── agent/main.py          ← the one xray.attach() call
├── driver/test_e2e.py     ← pytest; drives one Replay
└── fixtures/user_turn_1.wav  ← 48kHz mono int16, ~2s
```

## Quickstart

```bash
# 1. Get a Gemini API key — https://aistudio.google.com/app/apikey
cp .env.example .env
# edit .env, set GEMINI_API_KEY=...

# 2. Boot livekit + xray + agent
docker compose up --build

# 3. In another shell — drive one Replay
docker compose --profile test run --rm driver

# 4. Open the inspector — http://localhost:8080
```

## Expected log noise

The agent container prints **2 `ERROR` entries** from
`opentelemetry.sdk._shared_internal` during startup, complaining about
connection refused on `127.0.0.1:1`. This is by design:

- Langfuse v3 unconditionally installs its own OTLP exporter pointing
  at `LANGFUSE_HOST` when given API keys.
- The example sets fake Langfuse keys (so `@observe` emits spans into
  xray's vocabulary) and points `LANGFUSE_HOST` at a non-routable
  address so the cloud upload fails fast.
- xray's own exporter is unaffected — those spans land at xray
  normally; the test passes.

In real use with real Langfuse keys + host, no errors appear and both
Langfuse and xray receive the spans in parallel.

## Adapting to your own agent

Two lines in your existing LiveKit Agents entrypoint:

```python
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    async with xray.attach(ctx, service_name="my-agent"):
        # your existing agent code — unchanged
        ...
```

See `docs/integrate.md` for the deep-dive.

## The fixture

`fixtures/user_turn_1.wav` was generated via macOS `say` → `ffmpeg` so
the example has no runtime OpenAI-key dependency. Bytes are committed
(~220 KB).

For your own conversations, point `RecordedAudio(path=...)` at any
**48 kHz / mono / 16-bit** WAV:

```bash
ffmpeg -i input.wav -ar 48000 -ac 1 -sample_fmt s16 output.wav
```

or use `TtsAudio()` with `OPENAI_API_KEY` set in your driver process.
