# xray + LiveKit voice agent

Minimal `docker compose` stack — **xray**, a **LiveKit** server, and a
**Gemini Live voice agent** — plus a pytest driver that runs one Replay
end-to-end. Demonstrates the one-line `xray.attach(ctx)` integration.

```
.
├── compose.yaml           ← livekit, xray, agent, driver(profile:test)
├── .env.example           ← only GEMINI_API_KEY required
├── agent/main.py          ← the one xray.attach() call
├── driver/test_e2e.py     ← pytest; drives one Replay
└── fixtures/user_turn_1.wav
```

## Quickstart

```bash
cd examples/livekit-voice-agent

# 1. Get a Gemini API key — https://aistudio.google.com/app/apikey
cp .env.example .env
# edit .env, set GEMINI_API_KEY=...

# 2. Boot livekit + xray + agent (streams logs — keep this shell open and
#    wait for "registered worker" before moving on).
docker compose up --build

# 3. In another shell — drive one Replay. The driver lives under a
#    `test` profile so `compose up` doesn't auto-run it; this command
#    opts in explicitly.
docker compose --profile test run --rm driver

# 4. Open the inspector — http://localhost:8080
```

## Adapting to your own agent

Two lines in your existing LiveKit Agents entrypoint:

```python
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    async with xray.attach(ctx, service_name="my-agent"):
        # your existing agent code — unchanged
        ...
```

See [docs/integrate.md](../../docs/integrate.md) for the deep-dive.
