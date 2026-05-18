# xray-py — SDK guide

The Python SDK has three pieces. Each one is independently usable; `xray.run(...)` composes all three for the common case.

```
xray.conversation   — test definitions (Conversation, Turn, expect_agent_turn)
xray.trace          — OpenTelemetry decorators + baggage helpers
xray.runtime        — pluggable runtime ABC
xray.runtime.livekit — v1 LiveKit implementation
xray.run            — orchestrator (creates Conversation + Replay, runs the
                      runtime, evaluates assertions/judge, PATCHes the row)
```

## 1 · Conversation

A `Conversation` is a Python module the dev imports — it's not a YAML file, not a JSON spec, and there's no UI builder. The "Conversation as code" framing is the headline.

```python
from xray import Conversation, Turn, expect_agent_turn

conv = Conversation(
    id="booking-happy-path",
    title="Books a table for two",
    turns=[
        Turn.user("Hi, I'd like to book a table for two at 7pm.", key="u0"),
        expect_agent_turn(
            key="a0",
            assertion=lambda agent: "confirmed" in agent.transcript.lower(),
            assertion_name="confirms_booking",
        ),
    ],
)
```

### `id` and `version`

`id` is dev-chosen — typically the file's module name with hyphens. `version` is auto-computed as a SHA256 fingerprint of the turn structure (text, role, key, assertion presence). The SDK posts `(id, version)` to `POST /v1/conversations` as an idempotent upsert; xray rejects an upsert against the same `(id, version)` with a *different* fingerprint as `VersionFingerprintMismatchError` — i.e. the dev edited the spec without bumping `id`.

You can pin `version` explicitly (`Conversation(..., version="pinned-v1")`) if you'd rather control it. The fingerprint default is what we recommend.

### Turns

- `Turn.user(text, *, key=None, audio=None)` — the user-side script.
- `expect_agent_turn(*, key=None, assertion=None, assertion_name=None)` — the agent's response is observed at runtime; the assertion runs against the captured `AgentResponse`.

`key` is the cross-Conversation alignment join key surfaced in compare views. Without `key`, the UI aligns positionally — which is fine until you add a turn in the middle.

### Assertions

Per-turn predicates run in the SDK process against `AgentResponse(transcript, audio_path, duration_ms)`. Return `True` / `False` / raise (counts as `errored`). They are evaluated synchronously after the runtime returns and posted to xray via `PATCH /v1/replays/:id` — they do not require the OTEL receiver to be reachable.

### Judges

Optional per-replay predicate that receives a `ReplayResult` and returns a `JudgeOutcome(status, score?, reason?, error?)`. The judge runs in your process against your LLM credentials — **xray never holds LLM provider keys** by design. This keeps secrets out of the single-image distribution.

## 2 · `xray.trace`

`xray.trace.set_replay_context(replay_id, conversation_id, conversation_version)` attaches the replay identity to the current OpenTelemetry context as baggage. Every span the agent emits in this asyncio task / thread inherits it — your `gen_ai.*` and Langfuse spans pick up `xray.replay.id` automatically and route to the right Replay.

```python
from xray.trace import set_replay_context, stage

# In your LiveKit agent's on-room-joined handler:
metadata = json.loads(room.metadata or "{}")
set_replay_context(
    replay_id=metadata["xray.replay.id"],
    conversation_id=metadata["xray.conversation.id"],
    conversation_version=metadata["xray.conversation.version"],
)

# Per-stage timing — STT and TTS in v1
@stage("stt")
async def transcribe(audio_chunk):
    return await my_stt.transcribe(audio_chunk)
```

`stage("stt")` / `stage("tts")` wrap the function in an `xray.stage.<name>` span and stamp the baggage on it.

## 3 · `xray.runtime`

A `Runtime` joins your transport (LiveKit room, Pipecat session, …), plays the user side of the Conversation, captures the agent's output per turn, and returns a `RuntimeResult`.

```python
from xray.runtime.base import Runtime, RuntimeResult

class MyRuntime(Runtime):
    async def run(self, conversation) -> RuntimeResult: ...
    async def aclose(self) -> None: ...
```

v1 ships `xray.runtime.livekit.LiveKitRuntime`. Other runtimes (Pipecat, OpenAI Realtime, Gemini Live, raw WebSocket) are on the roadmap — the ABC exists from day one so adding one is a new sub-module, not a refactor.

## 4 · `xray.run(...)`

The convenience orchestrator. Lifecycle:

1. `POST /v1/conversations` — idempotent upsert keyed by `(id, version)`.
2. `POST /v1/replays` — eager row creation; returns `replay_id`.
3. `runtime.bind(replay_id, conversation_id, conversation_version)` — gives the runtime the values it propagates as LiveKit room metadata.
4. `await runtime.run(conversation)` — captures `RuntimeResult` (responses + optional full audio/transcript).
5. Per-turn assertions evaluate against `RuntimeResult.responses`.
6. Per-replay judge (if any) evaluates against the assembled `ReplayResult`.
7. `PATCH /v1/replays/:id` — final status (`completed` / `failed`) + judge result.

Sync (`run(...)`) and async (`run_async(...)`) entrypoints are both exported.

## What lives on the SDK side vs. the xray side

| Concern | Lives in |
|---|---|
| Conversation definition + fingerprint | SDK (Python) |
| LiveKit room join + audio I/O | SDK (`LiveKitRuntime`) |
| Assertion predicates | SDK process (your machine) |
| LLM judge | SDK process — xray never holds your provider keys |
| Conversation + Replay rows | xray (single source of truth) |
| OTLP span persistence + filtering | xray (filter-not-gate via vocabulary registry) |
| Audio bytes (per turn + full mixdown) | xray volume (`XRAY_AUDIO_ROOT`, default `/data/audio`) |

## Security

No auth on the SDK→xray wire. Keep port 8080 private — same Docker network is the assumed deployment. The README documents the bind.
