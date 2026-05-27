# xray + LiveKit voice agent

Minimal `docker compose` stack — **xray**, a **LiveKit** server, and a
**Gemini Live voice agent** — plus a pytest driver that runs one Replay
end-to-end. Demonstrates the one-line `xray.attach(ctx)` integration.

```
.
├── compose.yaml             ← scripted stack: livekit, xray, agent, driver(profile:test)
├── compose.live.yaml        ← overlay for the live mic session (LAN-exposed media)
├── livekit.yaml             ← scripted LiveKit config (loopback only)
├── livekit.live.yaml        ← live LiveKit config (host-reachable media)
├── .env.example             ← only GEMINI_API_KEY required
├── agent/main.py            ← the one xray.attach() call
├── driver/test_e2e.py       ← pytest; drives one scripted Replay
├── driver/live_session.py   ← interactive; talk to the agent over the mic
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

## Live mic session

Talk to the agent yourself instead of replaying a scripted WAV. The session
records your mic + the agent's audio and uploads it as a Replay, analyzed
just like the scripted run.

The driver runs on your **host** (it needs your real mic + speaker), so —
unlike the scripted Quickstart, which exposes no LAN ports — LiveKit's media
plane must be reachable from the host. That's the `compose.live.yaml` overlay:
it publishes media on `0.0.0.0` and advertises your host LAN IP. Boot the
stack **with the overlay** instead of Quickstart step 2:

```bash
# Your host LAN IP — reachable from the host driver AND the in-container agent.
export LIVEKIT_NODE_IP=$(ipconfig getifaddr en0)   # or `en1`; Linux: `hostname -I`

# Boot livekit (live config) + xray + agent. No scripted driver runs here.
docker compose -f compose.yaml -f compose.live.yaml up --build

# In another shell — install the SDK with the livekit + live (sounddevice)
# extras, then talk to the agent (Ctrl+C ends + uploads):
pip install -e '../../sdk/python[livekit,live]'
python driver/live_session.py

# Open the inspector — your live replay is at the top: http://localhost:8080
```

Wear headphones — an open speaker feeds the agent's voice back into your
mic. Set `XRAY_LIVE_NO_PLAYBACK=1` for a record-only run (you won't hear the
agent). The session is one call:

```python
import xray
from xray.runtime.livekit_live import LiveKitLiveRuntime

runtime = LiveKitLiveRuntime(url=..., api_key=..., api_secret=..., room=...)
result = await xray.run_live(runtime=runtime, xray_url="http://localhost:8080")
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
