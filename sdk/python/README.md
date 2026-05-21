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
import asyncio
import os

from xray import Conversation, RunConfig, Turn, run
from xray.conversation import TtsAudio
from xray.runtime.livekit import LiveKitRuntime


async def main() -> None:
    conv = Conversation(
        name="Books a table for two",
        turns=[
            Turn.user(
                "Hi, I'd like to book a table for two at 7pm.",
                key="u0",
                audio=TtsAudio(),  # or RecordedAudio(path="...wav")
            ),
            Turn.agent(
                key="a0",
                assertion=lambda agent: "confirmed" in agent.transcript.lower(),
                assertion_name="confirms_booking",
            ),
        ],
    )

    runtime = LiveKitRuntime(
        url=os.environ["LIVEKIT_URL"],
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
        room="booking-test-room",
    )

    result = await run(
        conversation=conv,
        runtime=runtime,
        xray_url="http://localhost:8080",
        run_config=RunConfig(model="gpt-4o", temperature=0.5),
    )
    print(f"replay {result.id} status={result.status} — {result.url}")


asyncio.run(main())
```

`Conversation` identity is a SHA-256 content hash over the turn array (including per-turn `RecordedAudio` bytes). `name` is a free-form display label — renaming the same spec attaches another Replay to the same Conversation row; editing any turn or WAV forks a new Conversation.

The runtime produces **one stereo WAV per replay** (left = user, right = agent); `run(...)` uploads it to `POST /v1/replays/:id/audio`. The inspector slices it per-turn using the `replay_turns` timestamps.

When a user `Turn` uses `TtsAudio()` (or has no `audio` + a text fallback), the runtime calls OpenAI's `/v1/audio/speech` directly using `OPENAI_API_KEY` from your environment — xray never sees the key — and caches the result at `~/.cache/xray-py/<conversation_hash>/<voice_id>.wav` so re-runs reuse the bytes.

## Three modules

- `xray.conversation` — `Conversation`, `Turn` test-definition primitives (`Turn.user(...)` / `Turn.agent(...)`).
- `xray.instrument` — `xray.attach(ctx, ...)` async context manager for LiveKit Agents worker entrypoints. Auto-binds the replay context from the JWT's `xray` attribute, installs the OTLP/JSON exporter, and force-flushes spans on exit. `xray.otel` exposes the lower-level `install` / `XraySpanExporter` / `XrayBaggageSpanProcessor` if you wire things manually.
- `xray.runtime` — pluggable `Runtime` ABC; `xray.runtime.livekit.LiveKitRuntime` is the v1 implementation.

## Environment

The LiveKit runtime reads:

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | yes | — | LiveKit credentials |
| `OPENAI_API_KEY` | only for TTS turns | — | OpenAI key used directly — xray never holds it |
| `OPENAI_TTS_MODEL` | no | `gpt-4o-mini-tts` | TTS model |
| `OPENAI_TTS_VOICE` | no | `alloy` | Voice; per-turn `TtsAudio(voice_id=...)` overrides |

Recorded audio must be **48 kHz mono 16-bit WAV** (`ffmpeg -i in.wav -ar 48000 -ac 1 -sample_fmt s16 out.wav`).

## How it wires to xray

1. `run(...)` POSTs a Replay to `POST /v1/replays` carrying the full Conversation spec. The server hashes the turns to derive `conversation_hash`, upserts the conversation row by hash (last-write-wins on `name`), inserts the replay, and returns `{id, conversation_hash}`.
2. The runtime joins the LiveKit room with `replay_id` + `conversation_hash` in room metadata.
3. The dev's agent reads metadata, propagates it via OTEL baggage on every span.
4. xray's OTLP receiver routes spans by `xray.replay.id` and persists what it recognizes (xray.*, OTel GenAI semconv, Langfuse).
5. `run(...)` uploads the mixdown WAV to `POST /v1/replays/:id/audio`.
6. `run(...)` evaluates per-turn assertions and PATCHes the Replay row with the final status.

See `docs/SDK.md` and `docs/WIRE.md` in the main repo for the contract.
