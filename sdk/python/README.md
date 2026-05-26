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

from xray import Assertion, Conversation, Judge, RunConfig, Turn, format_failures, run
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
                assertions=(
                    Assertion.contains("confirmed"),
                    Assertion.tool_called("reserve_table"),
                    Assertion.max_latency_ms(2_000),
                ),
            ),
        ],
        judges=(Judge.text_match("agent confirms a reservation for two", pass_score=80),),
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
    assert result.passed, format_failures(result)


asyncio.run(main())
```

`Conversation` identity is a SHA-256 content hash over the canonical spec (turns + per-turn `Assertion`s + conversation-level `Judge`s, with per-turn `RecordedAudio` bytes substituted in by sha256). `name` is a free-form display label — renaming the same spec attaches another Replay to the same Conversation row; editing any turn, assertion, judge, or WAV forks a new Conversation.

The runtime produces **one stereo WAV per replay** (left = user, right = agent); `run(...)` uploads it to `POST /v1/replays/:id/audio`. The inspector slices it per-turn using the `replay_turns` timestamps.

When a user `Turn` uses `TtsAudio()` (or has no `audio` + a text fallback), the runtime calls OpenAI's `/v1/audio/speech` directly using `OPENAI_API_KEY` from the SDK process's environment, and caches the result per-turn keyed on `(text, voice, model)` so re-runs reuse the bytes. Changing any of those invalidates the cache for that turn.

> **Note:** the xray *server* also needs `OPENAI_API_KEY` set in its own environment — it uses the key for Whisper (per-turn transcription) and the judge LLM during `/analyze`. The SDK and server hold the same env var name; both need it for their respective stages.

## Three modules

- `xray.conversation` — `Conversation`, `Turn` test-definition primitives (`Turn.user(...)` / `Turn.agent(...)`).
- `xray.instrument` — `xray.attach(ctx, ...)` async context manager for LiveKit Agents worker entrypoints. Auto-binds the replay context from the JWT's `xray` attribute, installs the OTLP/JSON exporter, and force-flushes spans on exit. `xray.otel` exposes the lower-level `install` / `XraySpanExporter` / `XrayBaggageSpanProcessor` if you wire things manually.
- `xray.runtime` — pluggable `Runtime` ABC; `xray.runtime.livekit.LiveKitRuntime` is the v1 implementation.

## Environment

The LiveKit runtime reads:

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | yes | — | LiveKit credentials |
| `OPENAI_API_KEY` | only for TTS turns | — | OpenAI key used directly by the SDK runtime for TTS. **xray's server also reads this var from its own env** for Whisper + judge. |
| `OPENAI_TTS_MODEL` | no | `gpt-4o-mini-tts` | TTS model |
| `OPENAI_TTS_VOICE` | no | `alloy` | Voice; per-turn `TtsAudio(voice_id=...)` overrides |

Recorded audio must be **48 kHz mono 16-bit WAV** (`ffmpeg -i in.wav -ar 48000 -ac 1 -sample_fmt s16 out.wav`).

## How it wires to xray

1. `run(...)` POSTs the Conversation to `/v1/conversations` (multipart with the canonical `spec` JSON + one file part per `RecordedAudio` turn). The server hashes the spec and upserts the conversation row by hash; assertions and judges are part of the hashed identity. It returns `{hash}`.
2. `run(...)` POSTs the Replay to `/v1/replays` referencing the hash. The server returns `{id}`.
3. The runtime joins the LiveKit room with `replay_id` + `conversation_hash` encoded as a JWT participant attribute (LiveKit `participant.attributes` ≥ v1.7).
4. `xray.attach(ctx, ...)` reads the attribute, sets OTEL baggage, and the `XrayBaggageSpanProcessor` lifts it onto every span. xray's OTLP receiver routes spans by `xray.replay.id` and persists what it recognizes (`xray.*`, OTel GenAI semconv, Langfuse).
5. `run(...)` uploads the mixdown WAV to `/v1/replays/:id/audio` and triggers `/v1/replays/:id/analyze`. The server runs VAD + Whisper transcription + per-turn metrics + every declared `Assertion` and `Judge`, then emits `evaluation_complete` over SSE.
6. `run(...)` reads the SSE event and returns `ReplayResult` with `passed` plus per-assertion / per-judge outcomes. Assertion failures don't raise — `assert result.passed` is the pytest idiom.

See `docs/integrate.md` and `docs/architecture.md` in the main repo for the contract.
