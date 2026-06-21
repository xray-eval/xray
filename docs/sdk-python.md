---
title: Python SDK
---

# Python SDK (`xray-py`)

The Python SDK does three jobs for you:

1. You author conversations (the scripts your agent will be tested against).
2. You drive those conversations against your LiveKit agent. LiveKit is the framework your voice agent runs on.
3. You wire the agent so its OpenTelemetry spans land in xray. OpenTelemetry (OTel) is a standard for emitting trace data; a "span" is one timed unit of work.

This page is the authoritative reference. It is generated from the source code, and kept in sync with it. The source lives under [`sdk/python/`](https://github.com/xray-eval/xray/tree/main/sdk/python).

Quick facts:

- Package: **`xray-py`**. Import name: **`xray`**. License: Elastic-2.0. Ships `py.typed` (so type checkers see its types).
- Requires **Python ≥ 3.10**.
- Everything listed in `__all__` is importable directly as `xray.<name>`.

---

## Install

```bash
pip install xray-py             # base - authoring + a custom Runtime
pip install "xray-py[livekit]"  # the scripted + live LiveKit runtimes
pip install "xray-py[live]"     # OS-mic capture for run_live (sounddevice)
```

The base install pulls in these dependencies: `httpx`, the OpenTelemetry API/SDK plus the OTLP/HTTP exporter, `pydantic`, and `typing-extensions`.

The extras add more:

- The `[livekit]` extra pulls in `livekit` and `livekit-api`.
- The `[live]` extra adds `sounddevice` for microphone capture.

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

A few things live one import level below the top, not at `xray.<name>`:

- The runtimes: `xray.runtime.livekit.LiveKitRuntime` and `xray.runtime.livekit_live.LiveKitLiveRuntime`.
- The `Runtime` ABC plus its protocols, in `xray.runtime.base`.
- The low-level OTEL helpers `install`, `XraySpanExporter`, and `XrayBaggageSpanProcessor`, in `xray.otel`.

Two naming notes, so you don't go looking for the wrong symbol:

> There is **no `LiveKitDriver`**. The v1 LiveKit class is `LiveKitRuntime`.
> There is **no `xray.instrument` decorator**. The wiring entry point is the
> async context manager `attach`.

---

## Authoring a Conversation

Here is a complete example. Read the sections below for what each piece does.

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

A `Conversation`'s identity is a SHA-256 content hash. The hash is computed over the canonical spec: the turns, the per-turn assertions, and the judges. Any `RecordedAudio` bytes are folded in by their sha256.

What this means in practice:

- `name` is a free-form display label. It is not part of the identity.
- Renaming the same spec re-attaches Replays to the same Conversation row.
- Editing any turn, assertion, judge, or WAV forks a new Conversation.

The server computes the hash. The SDK never hashes anything.

Construction raises `ValueError` in two cases: an empty `name`, or empty `turns` (unless `live=True`).

### `Turn`

```python
Turn.user(text: str, *, key=None, audio: AudioRef | None = None, assertions=()) -> Turn
Turn.agent(*, key=None, assertions=()) -> Turn
```

Note that `Turn.agent` takes **no `text`**. You don't declare what the agent says. The agent's text is observed at runtime and transcribed server-side.

A user turn with no `audio` is sent as a server-side TTS marker. TTS means text-to-speech: the server generates the audio. See [Audio references](#audio-references).

### Assertions

An assertion is a single declarative check on one turn.

All nine builders are `Assertion` classmethods. They validate their arguments at construction time, so a bad argument raises `ValueError` right away (fail-fast). All of them run **server-side**, during the `evaluate-replay` stage.

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

The tool assertions and the TTFT assertion need span-to-turn attribution. That is, xray has to map each span onto the audio timeline to know which turn it belongs to. (TTFT means time-to-first-token: how long the model takes to start replying.)

To do that mapping, xray needs a recording anchor: the wall-clock time of the first audio sample. If the runtime uploaded no anchor, these assertions come back **`errored`**, not failed. Without the anchor xray cannot place spans on the timeline. `LiveKitRuntime` always reports the anchor. A custom `Runtime` must report it too (see [Runtimes](#runtimes)).

### Judges

```python
Judge.text_match(reference: str, *, rubric: str | None = None, pass_score: int = 70) -> Judge
```

A judge is a conversation-level LLM evaluator. It scores the whole transcript, not a single turn.

Here is how `text_match` works. The server asks the configured judge model to score the full transcript against `reference`. You can optionally guide the scoring with `rubric`. The score is on a 0 to 100 scale. The judge passes only when `score >= pass_score`.

`text_match` is the only judge kind in v1.

Validation raises `ValueError` for any of these: an empty `reference`, an empty `rubric`, or a `pass_score` outside `0..100`.

### Audio references

```python
RecordedAudio(path: str)        # an on-disk WAV: 48 kHz, mono, 16-bit
TtsAudio(voice_id: str | None = None)
```

A user turn's `audio` is one of these two references. You can also omit it, which is the same as passing `TtsAudio()`.

- **`RecordedAudio`** is a real WAV file you already have. Its bytes are uploaded as a multipart file part alongside the conversation, and folded into the hash.
- **`TtsAudio`** is just a marker. It tells the **server** to synthesize the turn for you.

Here is what the server does with a `TtsAudio` marker:

1. It synthesizes the audio at conversation-upsert time, using the provider it's configured with (`XRAY_TTS_PROVIDER`). The voice comes from `XRAY_TTS_VOICE`, or from the per-turn `voice_id`.
2. It content-addresses the WAV (keys it by content).
3. It folds the WAV's sha256 into the conversation hash.

**The SDK does no TTS.** There is no provider key in the SDK process. When you call `run(...)`, it simply fetches the synthesized bytes back over HTTP before driving the room.

To convert a WAV to the required format, use:
`ffmpeg -i in.wav -ar 48000 -ac 1 -sample_fmt s16 out.wav`.

xray does not host every voice. For voices it doesn't host (Cartesia, ElevenLabs, Deepgram, and so on), synthesize the audio externally and pass the result as `RecordedAudio`.

---

## `RunConfig`

```python
RunConfig(model: str | None = None, temperature: float | None = None,
          extra: dict[str, JsonValue] = {})
```

This is per-replay configuration. It is carried to the server on `POST /v1/replays`.

Two details about how it goes over the wire:

- `extra` keys are flattened to the top level. This lets the compare UI diff them as first-class columns.
- `model` and `temperature` are omitted entirely when they are `None`.

---

## Running

### `run`: scripted

```python
async def run(*, conversation: Conversation, runtime: Runtime,
              xray_url: str = "http://localhost:8080",
              run_config: RunConfig | None = None) -> ReplayResult
```

This function is fully keyword-only and async. There is no sync `run`. For a sync test harness, wrap the call in `asyncio.run(...)`.

End to end, here is what `run` does:

1. Checks that every `RecordedAudio` file exists locally.
2. POSTs the Conversation to `/v1/conversations` and reads back the hash. The body is multipart: a `spec` JSON part plus one file part per `RecordedAudio` turn.
3. Prefetches every user turn's audio (the bytes the server synthesized or stored). It does this before creating the replay, so a failure leaves no orphan row behind.
4. POSTs the Replay to `/v1/replays` (`{conversation_hash, run_config?}`) and reads back its `id`.
5. Drives the runtime. This step binds the replay context, injects the user audio, installs the OTEL pipeline pointed at `xray_url`, attaches the replay baggage, runs the runtime, then force-flushes the spans.
6. Uploads the stereo mixdown WAV to `/v1/replays/:id/audio` with the `X-Recording-Started-At` header, then POSTs `/v1/replays/:id/analyze`.
7. Streams `/v1/replays/:id/events` until one of two events arrives. On `evaluation_complete` it returns a `ReplayResult`. On `failed` it raises `ReplayEvaluationError`.

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

A failed assertion or judge **does not raise**. Each one is an outcome on the result instead. The pytest idiom is `assert result.passed, xray.format_failures(result)`.

Only two kinds of fault raise: driver-side faults (`XrayError` subclasses) and server-chain crashes (`ReplayEvaluationError`).

### `run_live`: unscripted (OS mic)

```python
async def run_live(*, runtime: Runtime, xray_url: str = "http://localhost:8080",
                   name: str | None = None,
                   run_config: RunConfig | None = None) -> ReplayResult
```

Use this when you want to talk to the agent yourself, instead of replaying a scripted WAV.

There is no authored `Conversation` here. Instead, `run_live` builds an empty `live=True` Conversation for you. It is named `name`, or `live-<timestamp>` if you pass no name. The server salts the hash so each session is its own row. `run_live` records your mic plus the agent's audio, and analyzes the result the same way `run` does.

To end the session, press Ctrl-C (SIGINT). That stops the session and uploads it.

The returned `ReplayResult` has empty `assertions` and `judges`, and `passed=True`. Its `metrics` are populated.

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

Wrap your LiveKit Agents worker entrypoint with `attach`. It is an **async context manager, not a decorator**. A decorator wrapper would break LiveKit Agents' forkserver pickling.

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

A few rules for using `attach`:

- Call it **after** `ctx.connect(...)`. Before connect, the room has no remote participants to scan.
- Endpoint resolution follows this order: the explicit `endpoint=` argument first, then the `XRAY_OTLP_ENDPOINT` environment variable, then none. With no endpoint, `attach` still binds baggage in-process but installs no OTLP exporter. (In production no participant carries the `xray` attribute. So `attach` yields `None` and is effectively a no-op.)
- On block exit, `attach` detaches the baggage and force-flushes the tracer provider. This makes sure spans land before the worker shuts down.

`ctx` is duck-typed. Any object works as long as it exposes `.room.remote_participants` plus `.on` / `.off` event hooks. The SDK does not import `livekit.agents`.

### Replay-context propagation

The replay context travels on the joining participant's **JWT `xray` attribute**. (A JWT is a signed token; "attribute" here means a field on the participant.) The SDK reads it via `participant.attributes["xray"]`.

No room or participant metadata is set, and no `can_update_own_metadata` grant is required.

The JSON payload is exactly this:

```json
{ "replay_id": "...", "conversation_hash": "...", "modality": "voice" }
```

Here is the chain that happens next:

1. `attach` reads that payload.
2. It sets OTEL baggage (`xray.replay.id`, `xray.conversation.hash`, `xray.modality`). Baggage is OTel's way of carrying key-value context along a trace.
3. The bundled span processor lifts that baggage onto every span at start.
4. The server routes spans by `xray.replay.id`.

### `XraySession`

`attach` yields an `XraySession` (or `None`). The session exposes three read-only fields: `replay_id`, `conversation_hash`, and `modality`. It also exposes one helper:

```python
async with session.turn(idx, key=None):
    ...   # emits an xray.turn span + scopes xray.turn.* baggage for this turn
```

### Low-level OTEL helpers (`xray.otel`)

Use these only if you wire OpenTelemetry manually instead of using `attach`:

- `install(*, endpoint, tracer_provider=None) -> TracerProvider`. This is idempotent (safe to call more than once). It registers the baggage span processor plus a batch exporter.
- `XraySpanExporter`. This POSTs **OTLP/JSON** to `${endpoint}/v1/otlp/v1/traces`.
- `XrayBaggageSpanProcessor`. This lifts the `xray.*` baggage onto every span.

---

## Runtimes

A `Runtime` does two things: it drives one Conversation against your agent, and it produces the audio recording.

`LiveKitRuntime` is the v1 implementation. You can subclass `Runtime` for any other transport.

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

`run(...)` turns `recording_started_at_epoch` into the `X-Recording-Started-At` upload header.

**A runtime that produces audio MUST report `recording_started_at_epoch`.** If you omit it, span-to-turn attribution is skipped. As a result, every `tool_called`, `tool_not_called`, `tool_args_match`, and `max_ttft_ms` assertion comes back `errored`.

The orchestrator also probes for some optional structural protocols. (They are `@runtime_checkable`, so the check is a runtime `isinstance` test.)

- `RuntimeBindable`: `bind(*, replay_id, conversation_hash)`.
- `UserAudioInjectable`: `inject_user_audio(audio: Mapping[int, bytes])`.
- `StoppableRuntime`: `request_stop()` (used by `run_live` on SIGINT).

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

This runtime joins the room as a user-side participant. It plays the per-turn user PCM (raw audio), captures the agent's audio and transcripts, and writes a wall-clock-aligned stereo WAV at 48 kHz / 16-bit. In that WAV, the left channel is the user and the right channel is the agent.

It implements `bind`, `inject_user_audio`, `run`, and `aclose`. Calling `run` before `bind` raises `RuntimeBindError`. Use it with `xray.run`.

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

This runtime powers `run_live`. It streams the OS microphone (which needs the `[live]` extra), publishes the mic frames, captures and optionally plays the agent's audio, and writes a live stereo mixdown.

For a record-only run, set `play_agent_audio=False` (or set `XRAY_LIVE_NO_PLAYBACK=1` in the example).

It emits no `xray.turn` spans. Turn boundaries come from server-side VAD instead. VAD (voice activity detection) finds where speech starts and stops.

### `SimulatedSipCall`

```python
SimulatedSipCall(
    caller_phone=None, trunk_phone=None, call_id=None, call_id_full=None,
    call_status=None, rule_id=None, trunk_id=None,
    extra_attrs: Mapping[str, str] = {},
)
```

Pass this to a runtime's `simulated_sip=` argument. It makes the driver join as a simulated SIP participant. (SIP is the protocol behind phone calls.)

When you pass it, the driver mints the JWT with `with_kind("sip")` plus the `sip.*` attributes: `sip.phoneNumber`, `sip.trunkPhoneNumber`, `sip.callID`, `sip.callStatus`, and so on.

`call_status` must be one of `"active"`, `"automation"`, `"dialing"`, `"hangup"`, or `"ringing"`.

Two cases raise `ValueError`: an all-empty object (use `simulated_sip=None` for a non-SIP run), and an `"xray"` key in `extra_attrs`.

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

`passed` is the aggregate verdict. It is `True` only when every assertion **and** every judge ran to `"passed"`. An `"errored"` outcome counts as not-passed.

```python
AssertionOutcome(turn_idx: int, assertion_idx: int, kind: str,
                 status: EvaluationStatus, message: str | None)
JudgeOutcome(judge_idx: int, kind: str, status: EvaluationStatus,
             score: int | None, reason: str | None)
TurnMetrics(turn_idx: int, role: Role, agent_response_ms: int | None,
            interrupted: bool)
```

`EvaluationStatus` is `"passed" | "failed" | "errored"`. `format_failures(result)` renders just the non-passed assertion and judge outcomes. If there are none, it returns `"all assertions and judges passed"`.

`AgentResponse`, `ToolCall`, and `ModelUsage` are informational records that the runtime captured during the run. They are **not** what evaluation reads. Evaluation runs server-side, from the declared catalog plus the OTLP spans.

---

## Errors

`XrayError` is the base SDK exception. Every subclass carries a `failure_reason`. These are the ones a test might want to catch:

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

Driver-side failures map to a `PATCH /v1/replays/:id`, so the replay records why it stopped. Lifecycle transitions during the analyze chain are owned by the server.

---

## See also

- [`integrate.md`](./integrate.md): the end-to-end walkthrough.
- [`wire-contract.md`](./wire-contract.md): what the agent's spans must look like.
- [`architecture.md`](./architecture.md): how the server turns a run into a verdict.
