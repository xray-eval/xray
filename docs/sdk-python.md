---
layout: default
title: Python SDK
nav_order: 4
---

# Python SDK (`xray-py`)

The Python SDK is how you author conversations, drive them against your
LiveKit agent, and wire the agent so its OpenTelemetry spans land in xray.
This is the authoritative reference; it is generated from — and kept in sync
with — the source under [`sdk/python/`](https://github.com/xray-eval/xray/tree/main/sdk/python).

- Package: **`xray-py`**, import name **`xray`**, Elastic-2.0, ships `py.typed`.
- Requires **Python ≥ 3.10**.
- Everything in `__all__` is importable directly as `xray.<name>`.

---

## Install

```bash
pip install xray-py             # base — authoring + a custom Runtime
pip install "xray-py[livekit]"  # the scripted + live LiveKit runtimes
pip install "xray-py[live]"     # OS-mic capture for run_live (sounddevice)
```

Base dependencies: `httpx`, the OpenTelemetry API/SDK + OTLP/HTTP exporter,
`pydantic`, `typing-extensions`. The `[livekit]` extra pulls in `livekit` +
`livekit-api`; `[live]` adds `sounddevice` for microphone capture.

---

## Public API surface

| Export | Kind | Purpose |
|---|---|---|
| `Conversation` | dataclass | The test spec: turns + conversation-level judges. |
| `Turn` | dataclass | One step; build via `Turn.user(...)` / `Turn.agent(...)`. |
| `Assertion` | dataclass | Declarative per-turn check; 9 builder classmethods. |
| `Judge` | dataclass | Conversation-level LLM evaluator; `Judge.text_match(...)`. |
| `RecordedAudio` / `TtsAudio` | dataclass | The two user-turn audio references. |
| `RunConfig` | dataclass | Per-replay config (model, temperature, extras). |
| `run` | async fn | Orchestrate a scripted Conversation → `ReplayResult`. |
| `run_live` | async fn | Orchestrate an unscripted OS-mic session → `ReplayResult`. |
| `attach` | async context manager | Wire xray onto a LiveKit Agents entrypoint. |
| `XraySession` | class | Agent-side handle yielded by `attach`; `.turn(idx)`. |
| `SimulatedSipCall` | dataclass | `sip.*` JWT attributes for a simulated SIP participant. |
| `ReplayResult` | dataclass | The server verdict returned by `run` / `run_live`. |
| `AssertionOutcome` / `JudgeOutcome` / `TurnMetrics` | dataclass | Per-item server results. |
| `AgentResponse` / `ToolCall` / `ModelUsage` | dataclass | Runtime-captured artifacts (informational). |
| `Role` / `EvaluationStatus` | type alias | `"user" \| "agent"` and `"passed" \| "failed" \| "errored"`. |
| `format_failures` | fn | Render non-passed outcomes as a string. |
| `XrayError` / `ReplayEvaluationError` | exception | SDK / server-chain errors. |

The runtimes and the low-level OTEL helpers live one import below the top
level: `xray.runtime.livekit.LiveKitRuntime`, `xray.runtime.livekit_live.LiveKitLiveRuntime`,
the `Runtime` ABC + protocols in `xray.runtime.base`, and `install` /
`XraySpanExporter` / `XrayBaggageSpanProcessor` in `xray.otel`.

> There is **no `LiveKitDriver`** — the v1 LiveKit class is `LiveKitRuntime`.
> There is **no `xray.instrument` decorator** — the wiring entry point is the
> async context manager `attach`.

---

## Authoring a Conversation

```python
from xray import Assertion, Conversation, Judge, Turn

conv = Conversation(
    name="booking-happy-path",
    turns=[
        Turn.user("Hi, I'd like to book a table for two at 7pm.", key="u0"),
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
```

### `Conversation`

```python
Conversation(name: str, turns: list[Turn], judges: tuple[Judge, ...] = (), live: bool = False)
```

A `Conversation`'s identity is a SHA-256 content hash over the canonical spec
(turns + per-turn assertions + judges, with any `RecordedAudio` bytes folded
in by their sha256). `name` is a free-form display label — renaming the same
spec re-attaches Replays to the same Conversation row; editing any turn,
assertion, judge, or WAV forks a new Conversation. The server computes the
hash; the SDK never hashes anything. Construction raises `ValueError` on an
empty `name`, or on empty `turns` unless `live=True`.

### `Turn`

```python
Turn.user(text: str, *, key=None, audio: AudioRef | None = None, assertions=()) -> Turn
Turn.agent(*, key=None, assertions=()) -> Turn
```

`Turn.agent` takes **no `text`** — the agent's text is observed at runtime and
transcribed server-side, not declared. A user turn with no `audio` is sent as
a server-side TTS marker (see [Audio references](#audio-references)).

### Assertions

All nine builders are `Assertion` classmethods and validate their arguments at
construction (fail-fast `ValueError`). All run **server-side** during the
`evaluate-replay` stage.

```python
Assertion.contains(text, *, case_insensitive=True)
Assertion.not_contains(text, *, case_insensitive=True)
Assertion.equals(text, *, case_insensitive=True, trim=True)
Assertion.regex(pattern, *, flags="")
Assertion.tool_called(name)
Assertion.tool_not_called(name)
Assertion.tool_args_match(name, args)            # args: dict[str, JsonValue]
Assertion.max_latency_ms(max_ms)                 # max_ms >= 1
Assertion.max_ttft_ms(max_ms)                    # max_ms >= 1
```

| Kind | Checks |
|---|---|
| `contains` / `not_contains` | The agent transcript does / does not contain `text`. |
| `equals` | The transcript equals `text` (optionally trimmed / case-insensitive). |
| `regex` | The transcript matches `pattern` (with optional `flags`). |
| `tool_called` / `tool_not_called` | A tool named `name` was / was not called in the turn. |
| `tool_args_match` | A `name` call's arguments match the given subset. |
| `max_latency_ms` | The agent responded within `max_ms` of the user turn ending. |
| `max_ttft_ms` | The model's time-to-first-chunk was within `max_ms`. |

The tool/TTFT assertions depend on span→turn attribution from the audio
timeline. If the runtime uploaded no recording anchor, they come back
**`errored`** (not failed) — xray can't place spans on the timeline without
it. `LiveKitRuntime` always reports the anchor; a custom `Runtime` must too
(see [Runtimes](#runtimes)).

### Judges

```python
Judge.text_match(reference: str, *, rubric: str | None = None, pass_score: int = 70) -> Judge
```

A conversation-level LLM judge: the server asks the configured judge model to
score the full transcript against `reference` (optionally guided by `rubric`)
on a 0–100 scale, passing iff `score >= pass_score`. `text_match` is the only
judge kind in v1. Validation raises `ValueError` on an empty `reference`, an
empty `rubric`, or a `pass_score` outside `0..100`.

### Audio references

```python
RecordedAudio(path: str)        # an on-disk WAV: 48 kHz, mono, 16-bit
TtsAudio(voice_id: str | None = None)
```

A user turn's `audio` is one of these (or omitted, which is equivalent to
`TtsAudio()`):

- **`RecordedAudio`** — a real WAV you already have. Its bytes are uploaded as
  a multipart file part with the conversation and folded into the hash.
- **`TtsAudio`** — a marker that the **server** should synthesize the turn.
  The xray server synthesizes at conversation-upsert time using the provider
  it's configured with (`XRAY_TTS_PROVIDER`, voice from `XRAY_TTS_VOICE` or the
  per-turn `voice_id`), content-addresses the WAV, and folds its sha256 into
  the conversation hash. **The SDK does no TTS** — no provider key in the SDK
  process. `run(...)` simply fetches the synthesized bytes back over HTTP
  before driving the room.

Convert a WAV to the required format with
`ffmpeg -i in.wav -ar 48000 -ac 1 -sample_fmt s16 out.wav`. For voices xray
doesn't host (Cartesia, ElevenLabs, Deepgram, …), synthesize externally and
pass the result as `RecordedAudio`.

---

## `RunConfig`

```python
RunConfig(model: str | None = None, temperature: float | None = None,
          extra: dict[str, JsonValue] = {})
```

Per-replay configuration carried to the server on `POST /v1/replays`. `extra`
keys are flattened to the top level on the wire so the compare UI diffs them
as first-class columns; `model` / `temperature` are omitted when `None`.

---

## Running

### `run` — scripted

```python
async def run(*, conversation: Conversation, runtime: Runtime,
              xray_url: str = "http://localhost:8080",
              run_config: RunConfig | None = None) -> ReplayResult
```

Fully keyword-only and async — wrap in `asyncio.run(...)` for a sync harness.
There is no sync `run`. End to end it:

1. Checks every `RecordedAudio` file exists locally.
2. POSTs the Conversation to `/v1/conversations` (multipart: a `spec` JSON
   part + one file part per `RecordedAudio` turn) and reads back the hash.
3. Prefetches every user turn's audio (the bytes the server synthesized or
   stored) — before creating the replay, so a failure leaves no orphan row.
4. POSTs the Replay to `/v1/replays` (`{conversation_hash, run_config?}`) and
   reads back its `id`.
5. Drives the runtime: binds the replay context, injects user audio, installs
   the OTEL pipeline pointed at `xray_url`, attaches replay baggage, runs the
   runtime, then force-flushes spans.
6. Uploads the stereo mixdown WAV to `/v1/replays/:id/audio` with the
   `X-Recording-Started-At` header, then POSTs `/v1/replays/:id/analyze`.
7. Streams `/v1/replays/:id/events` until `evaluation_complete` (→ returns
   `ReplayResult`) or `failed` (→ raises `ReplayEvaluationError`).

```python
import asyncio
import xray
from xray import Assertion, Conversation, Judge, RunConfig, Turn
from xray.runtime.livekit import LiveKitRuntime

async def main() -> None:
    conv = Conversation(name="booking", turns=[...], judges=(...,))
    runtime = LiveKitRuntime(url=..., api_key=..., api_secret=..., room="booking-test")
    result = await xray.run(
        conversation=conv,
        runtime=runtime,
        xray_url="http://localhost:8080",
        run_config=RunConfig(model="gpt-4o", temperature=0.5),
    )
    assert result.passed, xray.format_failures(result)

asyncio.run(main())
```

Per-assertion and per-judge failures **do not raise** — they're outcomes on
the result. `assert result.passed, xray.format_failures(result)` is the pytest
idiom. Only driver-side faults (`XrayError` subclasses) and server-chain
crashes (`ReplayEvaluationError`) raise.

### `run_live` — unscripted (OS mic)

```python
async def run_live(*, runtime: Runtime, xray_url: str = "http://localhost:8080",
                   name: str | None = None,
                   run_config: RunConfig | None = None) -> ReplayResult
```

For talking to the agent yourself instead of replaying a scripted WAV. There's
no authored `Conversation`: `run_live` builds an empty `live=True` Conversation
(named `name` or `live-<timestamp>`; the server salts the hash so each session
is its own row), records your mic + the agent's audio, and analyzes the result
the same way. SIGINT (Ctrl-C) ends the session and uploads it. The returned
`ReplayResult` has empty `assertions` / `judges` and `passed=True`, but
populated `metrics`.

```python
from xray.runtime.livekit_live import LiveKitLiveRuntime

runtime = LiveKitLiveRuntime(url=..., api_key=..., api_secret=..., room=...)
result = await xray.run_live(runtime=runtime, xray_url="http://localhost:8080")
```

---

## Wiring the agent

### `attach`

```python
@asynccontextmanager
async def attach(ctx, *, service_name: str | None = None,
                 endpoint: str | None = None,
                 bind_timeout_s: float = 10.0) -> AsyncGenerator[XraySession | None, None]
```

Wrap your LiveKit Agents worker entrypoint with `attach`. It is an **async
context manager, not a decorator** — a decorator wrapper breaks LiveKit
Agents' forkserver pickling.

```python
import xray
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli

async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    async with xray.attach(ctx, service_name="my-agent") as session:
        # session is None when no xray-tagged participant joined (i.e. prod).
        await your_agent.run(ctx, session=session)

cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
```

- Call it **after** `ctx.connect(...)` — before connect, the room has no
  remote participants to scan.
- **Endpoint resolution:** the explicit `endpoint=` argument, else the
  `XRAY_OTLP_ENDPOINT` environment variable, else none. With no endpoint,
  `attach` still binds baggage in-process but installs no OTLP exporter. (In
  production no participant carries the `xray` attribute, so `attach` yields
  `None` and is effectively a no-op.)
- On block exit it detaches baggage and force-flushes the tracer provider so
  spans land before the worker shuts down.

`ctx` is duck-typed — any object exposing `.room.remote_participants` plus
`.on` / `.off` event hooks works; the SDK does not import `livekit.agents`.

### Replay-context propagation

The replay context travels on the joining participant's **JWT `xray`
attribute** (read via `participant.attributes["xray"]`). No room or participant
metadata is set, and no `can_update_own_metadata` grant is required. The JSON
payload is exactly:

```json
{ "replay_id": "...", "conversation_hash": "...", "modality": "voice" }
```

`attach` reads it, sets OTEL baggage (`xray.replay.id`,
`xray.conversation.hash`, `xray.modality`), and the bundled span processor
lifts that baggage onto every span at start. The server routes spans by
`xray.replay.id`.

### `XraySession`

`attach` yields an `XraySession` (or `None`). It exposes read-only
`replay_id` / `conversation_hash` / `modality`, plus one helper:

```python
async with session.turn(idx, key=None):
    ...   # emits an xray.turn span + scopes xray.turn.* baggage for this turn
```

### Low-level OTEL helpers (`xray.otel`)

If you wire OpenTelemetry manually instead of using `attach`:

- `install(*, endpoint, tracer_provider=None) -> TracerProvider` — idempotent;
  registers the baggage span processor + a batch exporter.
- `XraySpanExporter` — POSTs **OTLP/JSON** to `${endpoint}/v1/otlp/v1/traces`.
- `XrayBaggageSpanProcessor` — lifts the `xray.*` baggage onto every span.

---

## Runtimes

A `Runtime` drives one Conversation against your agent and produces the audio
recording. `LiveKitRuntime` is the v1 implementation; you can subclass
`Runtime` for any other transport.

### The `Runtime` ABC

```python
class Runtime(ABC):
    async def run(self, conversation: Conversation) -> RuntimeResult: ...
    async def aclose(self) -> None: ...
```

```python
@dataclass
class RuntimeResult:
    responses: list[AgentResponse] = field(default_factory=list)
    full_audio_path: str | None = None
    full_transcript: str | None = None
    recording_started_at_epoch: float | None = None   # Unix seconds of audio sample 0
```

`recording_started_at_epoch` is what `run(...)` turns into the
`X-Recording-Started-At` upload header. **A runtime that produces audio MUST
report it** — omit it and span→turn attribution is skipped, so every
`tool_called` / `tool_not_called` / `tool_args_match` / `max_ttft_ms`
assertion comes back `errored`.

Optional structural protocols the orchestrator probes for (`@runtime_checkable`):

- `RuntimeBindable` — `bind(*, replay_id, conversation_hash)`.
- `UserAudioInjectable` — `inject_user_audio(audio: Mapping[int, bytes])`.
- `StoppableRuntime` — `request_stop()` (used by `run_live` on SIGINT).

### `LiveKitRuntime`

```python
LiveKitRuntime(
    url: str, api_key: str, api_secret: str, room: str,
    identity: str = "xray-driver",
    agent_join_timeout_s: float = 30.0,
    agent_turn_timeout_s: float = 30.0,
    cache_root: Path = ~/.cache/xray-py,
    mixdown_dir: Path | None = None,
    simulated_sip: SimulatedSipCall | None = None,
)
```

Joins the room as a user-side participant, plays the per-turn user PCM, captures
the agent's audio + transcripts, and writes a wall-clock-aligned stereo WAV
(left = user, right = agent) at 48 kHz / 16-bit. Implements `bind`,
`inject_user_audio`, `run`, and `aclose`; `run` raises `RuntimeBindError` if
called before `bind`. Used with `xray.run`.

### `LiveKitLiveRuntime`

```python
LiveKitLiveRuntime(
    url: str, api_key: str, api_secret: str, room: str,
    identity: str = "xray-driver",
    agent_join_timeout_s: float = 30.0,
    agent_audio_timeout_s: float | None = None,
    play_agent_audio: bool = True,
    cache_root: Path = ~/.cache/xray-py,
    mixdown_dir: Path | None = None,
    simulated_sip: SimulatedSipCall | None = None,
)
```

Powers `run_live`: streams the OS microphone (needs the `[live]` extra),
publishes mic frames, captures and optionally plays the agent's audio, and
writes a live stereo mixdown. Set `play_agent_audio=False` (or
`XRAY_LIVE_NO_PLAYBACK=1` in the example) for a record-only run. It emits no
`xray.turn` spans — turn boundaries come from server-side VAD.

### `SimulatedSipCall`

```python
SimulatedSipCall(
    caller_phone=None, trunk_phone=None, call_id=None, call_id_full=None,
    call_status=None, rule_id=None, trunk_id=None,
    extra_attrs: Mapping[str, str] = {},
)
```

Pass to a runtime's `simulated_sip=` to make the driver join as a simulated SIP
participant: the driver mints the JWT with `with_kind("sip")` plus the `sip.*`
attributes (`sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.callID`,
`sip.callStatus`, …). `call_status` is one of `"active"`, `"automation"`,
`"dialing"`, `"hangup"`, `"ringing"`. An all-empty object raises `ValueError`
(use `simulated_sip=None` for a non-SIP run), as does an `"xray"` key in
`extra_attrs`.

---

## `ReplayResult` and outcomes

```python
@dataclass(frozen=True)
class ReplayResult:
    replay_id: str
    conversation_hash: str
    passed: bool
    assertions: tuple[AssertionOutcome, ...]
    judges: tuple[JudgeOutcome, ...]
    metrics: tuple[TurnMetrics, ...]
```

`passed` is the aggregate: `True` iff every assertion **and** every judge ran
to `"passed"` — `"errored"` counts as not-passed.

```python
AssertionOutcome(turn_idx: int, assertion_idx: int, kind: str,
                 status: EvaluationStatus, message: str | None)
JudgeOutcome(judge_idx: int, kind: str, status: EvaluationStatus,
             score: int | None, reason: str | None)
TurnMetrics(turn_idx: int, role: Role, agent_response_ms: int | None,
            interrupted: bool)
```

`EvaluationStatus` is `"passed" | "failed" | "errored"`. `format_failures(result)`
renders just the non-passed assertion + judge outcomes (or
`"all assertions and judges passed"`).

`AgentResponse` / `ToolCall` / `ModelUsage` are informational records the
runtime captured during the run; they are **not** what evaluation reads
(evaluation runs server-side from the declared catalog + the OTLP spans).

---

## Errors

`XrayError` is the base SDK exception; every subclass carries a
`failure_reason`. The ones a test might catch:

| Class | `failure_reason` | When |
|---|---|---|
| `RuntimeBindError` | `driver_aborted` | `run()` called before `bind()`. |
| `AgentNotJoinedError` | `agent_not_joined` | The agent participant didn't join in time. |
| `AudioMissingError` | `audio_missing` | A user turn's audio can't be materialized, or a live session captured no frames. |
| `AudioTooLargeError` | `driver_aborted` | The mixdown exceeds 50 MiB. |
| `MixdownError` | `driver_aborted` | Writing the WAV mixdown failed. |
| `LiveKitDependencyError` / `LiveDependencyError` | `driver_aborted` | The `[livekit]` / `[live]` extra isn't installed. |
| `MicCaptureError` / `SpeakerPlaybackError` | `driver_aborted` | The OS mic / speaker can't be opened (live sessions). |
| `XrayServerError` | `driver_aborted` | An HTTP error from the server before the replay row exists. |
| `ReplayEvaluationError` | the failing stage | The server's analyze chain crashed before producing a verdict (`transcription_failed` / `metrics_failed` / `evaluation_failed`, …). Carries `replay_id`. |

Driver-side failures map to a `PATCH /v1/replays/:id` so the replay records why
it stopped. Lifecycle transitions during the analyze chain are server-owned.

---

## See also

- [`integrate.md`](./integrate.md) — the end-to-end walkthrough.
- [`wire-contract.md`](./wire-contract.md) — what the agent's spans must look like.
- [`architecture.md`](./architecture.md) — how the server turns a run into a verdict.
