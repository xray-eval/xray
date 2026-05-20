# 0001 · Audio-ground-truth refactor — server as analyzer, SDK as span emitter

**Status:** ready for implementation
**Date:** 2026-05-20 (drafted), 2026-05-20 (spike outcomes folded in)

## Spike outcomes (2026-05-20)

Six pre-implementation spikes ran. Results changed three sections of the spec; this preamble is the changelog.

| Spike | Outcome | Spec impact |
|---|---|---|
| libfvad WASM port availability | `@echogarden/fvad-wasm` exists (BSD-3, raw Emscripten) and `@ozymandiasthegreat/vad` exists (MIT, archived 2022). Decision: **ship a pure-JS energy VAD** instead — no third-party dep risk, trivially auditable. | §4.4 rewritten. |
| livekit-rtc Python audio API | `AudioStream(track, sample_rate=48000, num_channels=1)` for subscribe, `AudioSource.capture_frame(AudioFrame(...))` for publish. No per-frame timestamp from LiveKit — wall-clock from caller side is the only alignment. **Stereo WAV is already written today** by `write_stereo_mixdown` in `livekit.py:653` as turn-sequential mixdown. | §5.3 expanded with the rewrite scope. |
| Hono SSE | `streamSSE` from `hono/streaming` in Hono 4.12.18 works. Manual heartbeat via `stream.write(": heartbeat\\n\\n")`. `stream.onAbort(...)` is the disconnect hook. | §4.3 confirmed; no change. |
| bunqueue@2.7.12 embedded round-trip | API works. Three drift items from the original spec: (a) `durable: true` on `add()` does not exist; embedded mode always persists. (b) `updateProgress(progress: number, message?: string)` — not an object. (c) `progress` event listener receives `(job \| null, progress)`. Recovery on restart confirmed cross-process only. | §4.2 corrected. |
| Bun WAV r/w | Pure Bun stdlib works. `Buffer.writeInt16LE` for write; `DataView.getInt16(o, true)` for read. ~75 LOC combined for reader + writer + validator. ffprobe accepts output. 5 gotchas documented (LE always, `fmt ` padding, odd-size chunk alignment, LIST/JUNK chunk handling, async `arrayBuffer`). | §4.4 reader notes added. |
| Python OTel exporter | Stock `OTLPSpanExporter` from `opentelemetry-exporter-otlp-proto-http` sends `application/x-protobuf`. No first-party JSON HTTP exporter exists. xray's receiver accepts both. **Switching to stock protobuf exporter** drops the hand-rolled `XraySpanExporter` and the `MessageToJson` dependency. `BatchSpanProcessor.force_flush(timeout_millis)` blocks but the timeout argument is currently a no-op (open upstream issue #4568). | §5.1 + §5.2 updated. |

## Final decisions

- **VAD:** ship a pure-JS energy/zero-crossing VAD inside `src/server/audio/`. ~150 LOC, no third-party dep, no native build, no WASM colocation worry. Accuracy is below libfvad but adequate for v0 with the strict-interleaved conversation model. Upgrade path is documented if accuracy bites.
- **Python OTel exporter:** stock `OTLPSpanExporter` (protobuf). Delete `XraySpanExporter` + `MessageToJson` usage.
- **LiveKit Python pin:** keep `livekit>=1.0` (today's behavior). No tightening this PR.
- **Stereo WAV alignment:** wall-clock-aligned, rewritten in this PR. Replace turn-sequential `write_stereo_mixdown` with a continuous capture-and-mux model. Driver writes to both channels of a shared time-keyed buffer; barge-in / agent-latency become representable in the file.
**Scope of this PR:** server + Python SDK. Frontend (`src/client/`) is explicitly out of scope and will land in a follow-up PR.
**Migration policy:** drop-and-recreate. xray is pre-1.0, alpha, no published GHCR image. Schema and wire are rewritten without compatibility shims.

---

## 1 · Summary

Today, the driver decides what a "turn" is and emits an `xray.turn` span carrying its own transcript. The server stores spans, joins them with the spec, and the SDK runs assertions client-side. This PR inverts the model:

- **The recorded audio is the ground truth.** The driver captures a stereo WAV (left = user audio it published, right = agent audio it received) and uploads the file at the end of a run.
- **The server is the analyzer.** A background job runs VAD on each channel, derives turn boundaries from the VAD output, and stores both (speech segments and turn boundaries). Later PRs will add transcription, assertion evaluation, and judge here too.
- **The SDK shrinks to an OTLP emitter.** The agent-side SDK is `xray.init()` (configures a standard OTel pipeline pointed at xray) + `xray.bind_replay()` (binds the active replay context per job) + `@xray.observe()` (a Langfuse-style decorator for custom spans). Nothing else. The test-side SDK is a driver definition + a `Conversation` spec + a `xray.run(...)` orchestrator that uploads audio at the end and streams analysis-state updates via SSE.

The trust boundary stays where it is: the SDK control plane is the only writer for `conversations` and `replays` rows; the OTLP receiver is a filter, not a gate. What changes is what the server *does* with what's written.

---

## 2 · Goals and non-goals

### In scope

1. Server: a background-job framework on top of **bunqueue@2.7.12** (pinned — see §9), persisted alongside `xray.db` in `/data/`. One job type initially: `analyze_replay`.
2. Server: webrtcvad-compatible VAD via Bun FFI, run per channel on uploaded stereo WAV.
3. Server: turn-derivation algorithm — boundaries computed from VAD segments per the rule "a turn begins immediately after the other side's last speech ends and runs until this side's last speech ends."
4. Server: schema rewrite to model (a) speech segments per channel, (b) derived turns with both boundaries.
5. Server: new endpoint `POST /v1/replays/:id/analyze` to enqueue the job. New endpoint `GET /v1/replays/:id/events` to stream state transitions via SSE.
6. SDK (Python): module restructure → `xray.init()` + `xray.bind_replay()` + `@xray.observe()`. Remove driver-side `xray.turn` emission and the legacy `xray.attach` async-CM.
7. SDK (Python): `LiveKitDriver` records stereo locally (subscribes to remote agent track, mixes against its own published user PCM), uploads on completion, then waits via SSE until terminal lifecycle state.
8. Removal: assertions and the per-replay judge are dropped from this PR. They return in a follow-up under a sync-from-SDK / evaluate-on-server model.

### Out of scope (explicitly)

- **Frontend.** SPA is allowed to break. Read endpoints change shape; the follow-up PR rebuilds the inspector against the new schema.
- **Transcription.** No accurate-transcript step yet. VAD output is stored without text. Follow-up PR.
- **Non-LiveKit runtimes.** The `Driver` interface is designed to generalize (pipecat, raw websocket), but only the LiveKit impl ships.
- **Conversation spec rework.** `Turn.user(audio=..., text=..., key=...)` and `Turn.agent(key=...)` stay as-is in the SDK. Server still ingests them via the existing `POST /v1/conversations` upsert. A future PR will revisit the spec shape (and assertion authoring).
- **`xray.stage.*` extraction.** Stage spans are stored as raw OTLP spans (timeline display) but are no longer extracted into structured rows. They're not the source of truth for metrics — VAD-derived turns are.

### Non-goals (anti-features)

- No client-side OTEL filtering. The SDK forwards every span the dev's agent process emits to xray. Server-side vocabulary registry decides what to extract (current behavior, retained).
- No second SQLite database in xray's connection layer. bunqueue *does* open its own SQLite file (acknowledged tradeoff with `single-image-distribution.md` — same volume, two files); xray's own slices keep reading from `/data/xray.db` via `bun:sqlite`.
- No real-time streaming analysis. Audio uploads at end of run; VAD runs once.

---

## 3 · Architecture

### 3.1 New three-process flow

```
DRIVER (test side)                            xray (single Bun process)
─────────────────────────                     ─────────────────────────────
1. POST /v1/conversations  ─────────────────► upsert (id, version) → turns_json
2. POST /v1/replays        ─────────────────► row created, lifecycle=pending
3. driver:
   - records published user PCM (L ch)
   - subscribes to agent track  (R ch)
   - mixes stereo WAV on its clock
4. driver streams OTEL spans  ──────────────► /v1/otlp/v1/traces (existing path)
   to xray, filtered server-side
5. POST /v1/replays/:id/audio (stereo) ─────► WAV → XRAY_AUDIO_ROOT, lifecycle=recording_uploaded
6. POST /v1/replays/:id/analyze ────────────► enqueue bunqueue job `analyze_replay`
                                              lifecycle=analyzing, analysis_step=vad
7. GET /v1/replays/:id/events (SSE) ◄───────  stream state transitions

                                              [background worker]
                                              - VAD left channel  → speech_segments rows
                                              - VAD right channel → speech_segments rows
                                              - derive turns       → replay_turns rows
                                              - lifecycle=completed | failed

AGENT WORKER (dev's code, optional for this PR's tests)
─────────────────────────────
xray.init() at startup
async with xray.bind_replay(ctx):  # reads LiveKit JWT 'xray' attr
    @xray.observe()
    def do_stuff(...): ...
# OTLP exporter sends spans → /v1/otlp/v1/traces
```

### 3.2 The two write paths — updated

1. **Control plane** — five endpoints now:
   - `POST /v1/conversations` (unchanged)
   - `POST /v1/replays` (unchanged shape; new lifecycle column)
   - `POST /v1/replays/:id/audio` (now stereo; sets lifecycle=`recording_uploaded`)
   - `POST /v1/replays/:id/analyze` (new; enqueues job, sets lifecycle=`analyzing`)
   - `PATCH /v1/replays/:id` (driver may set lifecycle=`failed` on early termination)
2. **OTLP receiver** — unchanged: `POST /v1/otlp/v1/traces`, vocabularies in `src/server/otlp/vocabularies/`. Removed: `xray.turn` extraction (no longer emitted). Kept: `xray.stage`, `xray.judge`, `xray.assertion` are still recognized but no longer mapped to structured rows in this PR (assertions/judge are dropped; stage is timeline-only).

---

## 4 · Server changes

### 4.1 Schema (drop and recreate)

New `src/server/store/schema.ts`. Existing migrations folder is wiped (alpha policy). Tables, with column intent:

```
conversations                 -- unchanged
  id TEXT, version TEXT, turns_json TEXT, title TEXT, created_at TEXT
  PK (id, version)

replays
  id TEXT PK
  conversation_id TEXT, conversation_version TEXT  -- FK (conversations)
  lifecycle_state TEXT   -- 'pending'|'running'|'recording_uploaded'|'analyzing'|'completed'|'failed'
  analysis_step TEXT     -- nullable; 'vad' | 'turns' | (future) 'transcription'
  failure_reason TEXT    -- nullable; enum from bunqueue ('stalled','timeout','explicit_fail','max_attempts_exceeded','worker_lost') OR 'upload_failed' | 'driver_aborted'
  started_at TEXT, finished_at TEXT
  audio_path TEXT        -- relative path under XRAY_AUDIO_ROOT to stereo WAV
  run_config_json TEXT   -- moved off replay_meta; opaque dev pass-through
  job_id TEXT            -- bunqueue job id, nullable until analyze enqueued

speech_segments        -- NEW. VAD output, one row per detected speech chunk
  id INTEGER PK
  replay_id TEXT FK
  channel TEXT          -- 'user' | 'agent'
  start_ms INTEGER       -- offset from audio start
  end_ms INTEGER

replay_turns           -- REWRITTEN. Derived from speech_segments
  id INTEGER PK
  replay_id TEXT FK
  idx INTEGER            -- 0-based, ordered across both roles
  role TEXT              -- 'user' | 'agent'
  turn_start_ms INTEGER  -- "turn boundary" — directly after other side's last speech ended
  turn_end_ms INTEGER    -- "turn boundary" — this side's last speech ended
  voice_start_ms INTEGER -- "voice-active boundary" — this side's first speech in turn
  voice_end_ms INTEGER   -- "voice-active boundary" — same as turn_end_ms in current rule, kept for future flexibility
  UNIQUE (replay_id, idx)

tool_calls             -- unchanged columns (still extracted from gen_ai.* OTLP spans)
model_usage            -- unchanged columns
spans                  -- unchanged; raw OTLP spans for inspector timeline
```

**Removed:**
- `replay_meta` (1:1 table). Folded into `replays`. The old `judge_*` fields are gone (judge is dropped). `modality` is dropped (voice-only stays implicit; reintroduce when text/video lands).
- `assertions` table — dropped wholesale.

**Migration plan:** none. `drizzle generate` against the new schema; `pnpm dev` / startup runs the new migrations against a fresh DB. Any operator running an alpha install loses data on upgrade — documented in `CHANGELOG.md` and the v0.2.0 release notes.

### 4.2 Background jobs — bunqueue 2.7.12

**Slice:** `src/server/jobs/` — new vertical slice per `code-layout.md` §1.

```
src/server/jobs/
  jobs.bunqueue.ts        # bunqueue instance + worker registration
  jobs.types.ts           # Job payload + result Valibot schemas
  jobs.errors.ts          # JobError base, AnalysisFailedError, ...
  jobs.test-utils.ts      # in-test bunqueue setup (embedded, tmp file)
  jobs.bunqueue.test.ts   # round-trip: add → process → completed
  analyze-replay/
    analyze-replay.processor.ts        # the job body — calls vad + turn derivation
    analyze-replay.processor.test.ts
    analyze-replay.types.ts
```

**bunqueue config:**

- Pinned: `bunqueue@2.7.12` in `package.json`. Cooldown rule: 9 days old at time of writing — satisfies `pnpm-workspace.yaml` `minimumReleaseAge: 10080`. Document in commit message + `.claude/rules/supply-chain.md`-style justification on the dependency add.
- Data path: `BUNQUEUE_DATA_PATH=/data/bunqueue.db` (separate from `/data/xray.db`). Acknowledged tradeoff vs `single-image-distribution.md` ("one volume, two files"); operator backs up the whole `/data` volume.
- Worker: one queue named `analyze`, `concurrency: 1` initially (single-replay-at-a-time; can raise after profiling VAD).
- Retry: `maxAttempts: 3`, `strategy: 'exponential'`, base delay `2000ms`.
- DLQ: enabled with `autoRetry: false`, `maxAge: '7d'`. On DLQ entry, server flips `replays.lifecycle_state='failed'` and `failure_reason` to the bunqueue reason (`stalled`, `timeout`, etc.).
- Stalled-job recovery on startup (`recover()` runs in bunqueue's `backgroundTasks.ts` constructor): jobs in `active` state at last shutdown get re-queued.

**API shape — confirmed against bunqueue@2.7.12 (spike POC):**

```ts
import { Bunqueue } from "bunqueue/client";

const analyze = new Bunqueue<{ replayId: string }, { ok: boolean }>("analyze", {
  embedded: true,
  dataPath: process.env.BUNQUEUE_DATA_PATH ?? "/data/bunqueue.db",
  concurrency: 1,
  retry: { maxAttempts: 3, strategy: "exponential", delay: 2000 },
  processor: async (job) => {
    await job.updateProgress(0, "vad");
    // ... run VAD ...
    await job.updateProgress(50, "turns");
    // ... derive turns ...
    return { ok: true };
  },
});

await analyze.add("run", { replayId }, { attempts: 3 });
// NOTE: `durable: true` does NOT exist on JobOptions; embedded mode always persists.

analyze.on("progress", (job, progress) => {
  // job: Job<T> | null — handle the null case explicitly
  if (job === null) return;
  replayEvents.emit(job.payload.replayId, "progress", { step: lastStep, percent: progress });
});

analyze.on("completed", (job, result) => { /* ... */ });
analyze.on("failed", (job, err) => { /* ... */ });
```

### 4.3 New endpoints

#### `POST /v1/replays/:id/analyze`

**Request:** empty body.
**Response:** `202 Accepted`, `{ job_id: string, lifecycle_state: 'analyzing' }`.

**Behavior:**
1. Validate replay exists and `lifecycle_state === 'recording_uploaded'`. Otherwise typed error (`ReplayNotReadyForAnalysisError`).
2. Enqueue `analyze_replay` job with payload `{ replayId }`, durable.
3. Update `replays.lifecycle_state = 'analyzing'`, `analysis_step = 'vad'`, `job_id = <bunqueue id>`.

#### `GET /v1/replays/:id/events` — SSE

**Response:** `text/event-stream`. Each event:

```
event: state
data: {"lifecycle_state":"analyzing","analysis_step":"vad","timestamp":"..."}

event: progress
data: {"step":"vad","percent":42}

event: completed
data: {"lifecycle_state":"completed","analysis_step":null}

event: error
data: {"lifecycle_state":"failed","failure_reason":"timeout","timestamp":"..."}
```

**Behavior:**
1. Subscribe to a per-replay `EventEmitter` (in-process pub/sub keyed by `replayId`).
2. Server-side hooks:
   - bunqueue worker emits `progress` events → forwarded as `progress` SSE
   - state-transition writes to `replays` (via the service layer) emit `state` events → forwarded
   - terminal states close the stream after one final event
3. Heartbeat every 15s (`:\n\n` comment line) to keep proxies from idling out.
4. Slice: `src/server/replays/replays.events.ts` + `replays.events.test.ts`.

### 4.4 VAD implementation

Slice: `src/server/audio/`

```
src/server/audio/
  audio.vad.ts              # public: runVadOnChannel(pcm: Int16Array, sampleRate: number): Segment[]
  audio.vad.test.ts         # fixture-driven: known WAV with known speech segments
  audio.types.ts            # Segment = { start_ms: number; end_ms: number }
  audio.wav.ts              # WAV reader (header + PCM extraction; rejects non-stereo / non-48kHz int16)
  audio.wav.test.ts
  audio.test-utils.ts       # synthetic WAV builder for tests
```

**Library choice:** **pure-JS energy/zero-crossing VAD** (~150 LOC, in-tree). No third-party dep, no native build step, no WASM colocation worry, no supply-chain cooldown, trivially auditable. Decided after the libfvad WASM spike (see preamble): two ports exist but one is archived 2022 and the other is BSD-3 raw-Emscripten with no TS types — both require enough wrapper code that we may as well write the algorithm in-tree.

Accuracy is the tradeoff. Energy VAD is sensitive to background noise and quiet TTS voices. Acceptable for v0 because xray's input is the driver-controlled audio: published user PCM is the dev's own WAV / TTS output (no mic noise), and received agent PCM is from a clean WebRTC stream. Mitigation: configurable threshold per replay via `run_config`. Replacement path documented in §7 if real-world accuracy bites — drop in a Silero-VAD adapter or revisit libfvad WASM.

**Algorithm (pseudocode for the spec — exact tuning lives in `audio.vad.ts`):**

1. Split the channel PCM into 30ms frames (480 samples at 16kHz).
2. For each frame, compute:
   - Short-time energy (sum of squared samples) — voice has energy ≥ threshold.
   - Zero-crossing rate — voice has a moderate ZCR (high ZCR = noise, very low = silence).
3. Frame is "voiced" iff energy > `energy_threshold` AND `zcr_min < zcr < zcr_max`.
4. Segment glue: adjacent voiced frames within ≤ 200ms gap merge into one segment.
5. Discard segments shorter than 80ms.

**VAD config:**
- Sample rate: 16000 Hz. WAV reader downsamples 48k → 16k before VAD (linear or polyphase; linear is fine here).
- Frame size: 30ms (480 samples at 16kHz).
- Default energy threshold: tuned against fixture WAVs in `audio.vad.test.ts`. Tunable via env `XRAY_VAD_ENERGY_THRESHOLD` and per-replay via `run_config.vad_energy_threshold`.
- ZCR window: 0.05–0.45 (rough — to be tuned with fixtures).

**WAV reader** (`src/server/audio/audio.wav.ts`) — pure stdlib, confirmed by the WAV spike. Use `DataView.getInt16(offset, true)` for read (LE-only), `Buffer.writeInt16LE` for write. Walk RIFF chunks with `o += size + (size & 1)` (handle odd-size pad byte). Skip unknown chunks (LIST/JUNK/INFO). Reject non-stereo / non-48kHz / non-int16 files with a typed `InvalidWavFormatError`.

### 4.5 Turn derivation

Slice: `src/server/audio/audio.turns.ts` + `audio.turns.test.ts`.

```
function deriveTurns(user: Segment[], agent: Segment[]): Turn[]
```

**Algorithm** (matches the user's spec):

1. Merge all speech segments from both channels into a single timeline, tagged with their role.
2. Walk forward in time. Each role-change is a turn boundary candidate.
3. For each role, accumulate contiguous segments into one "turn": from the moment after the other side's last segment ended (`turn_start_ms`) to the moment this side's last segment in this run ends (`turn_end_ms`). Within that turn:
   - `voice_start_ms` = first speech-segment start in this turn (≥ `turn_start_ms`).
   - `voice_end_ms` = last speech-segment end in this turn (= `turn_end_ms` under the current rule, but stored separately for future overlap handling).
4. Output is ordered by `turn_start_ms`; `idx` assigned 0..N-1.

**Open question deferred to impl:** overlap handling (barge-in). Current rule produces nonsensical turns when both channels speak at the same time. v0 strategy: detect overlap, log a span attribute `xray.audio.overlap=true` on the affected turns, and proceed with the dominant-energy side as the "owner" of the turn. Document this in the algorithm's test fixtures. Refinement is a follow-up.

### 4.6 OTLP receiver — what changes

- The `xray.turn` vocabulary entry is **removed**. The vocabulary file `src/server/otlp/vocabularies/xray.ts` no longer extracts turns from spans.
- `gen_ai.*` extraction into `tool_calls` and `model_usage` is unchanged.
- `xray.stage.*` and `xray.judge` spans are accepted (vocabulary registry doesn't reject them — they land in `spans`) but no longer extracted into structured columns. `xray.assertion` spans are also accepted-but-not-extracted.
- New: receiver tolerates spans whose `xray.replay.id` resource attribute references a replay whose `lifecycle_state` is post-terminal — drop silently with a debug log.

---

## 5 · SDK changes (Python)

### 5.1 Module restructure

```
sdk/python/src/xray/
  __init__.py            # public exports
  init.py                # xray.init() — global OTel pipeline setup
  binding.py             # xray.bind_replay() — async CM, reads LK JWT or explicit args
  observe.py             # @xray.observe() decorator
  conversation.py        # unchanged: Conversation, Turn, RecordedAudio, TtsAudio
  orchestrator.py        # xray.run() — pushes Conversation+Replay, runs driver, uploads audio, waits on SSE
  config.py              # XRAY_OTLP_ENDPOINT, XRAY_SERVICE_NAME env handling
  errors.py              # XrayError, AnalysisFailedError, ReplayBindingMissingError
  events.py              # SSE client (httpx-sse) for the wait-on-analysis loop
  runtime/
    __init__.py
    base.py              # Driver ABC (renamed from Runtime; see below)
    livekit.py           # LiveKitDriver — local stereo capture
```

**Removed:**
- `xray.instrument` module (folded into `init` + `binding` + `observe`).
- `xray.attach` async-CM (replaced).
- `xray.otel` module — the hand-rolled `XraySpanExporter` (OTLP/JSON via `MessageToJson`) and `XrayBaggageSpanProcessor` are replaced by stock OTel components. See §5.2.

**Renamed:**
- `Runtime` ABC → `Driver` ABC (matches docs language; clearer that this is test-side, not the agent runtime).
- `LiveKitDriver` keeps its name (already correct).

### 5.2 New API surface

#### `xray.init(...)`

```python
def init(
    *,
    endpoint: str | None = None,           # default: env XRAY_OTLP_ENDPOINT
    service_name: str | None = None,       # default: env OTEL_SERVICE_NAME or "xray-agent"
    extra_resource_attrs: dict[str, str] | None = None,
) -> None:
    """
    Idempotent. Configures the global OTel TracerProvider with:
      - Resource: service.name + extra_resource_attrs
      - SpanProcessor: BaggageSpanProcessor (lifts xray.* baggage onto every span)
                       + BatchSpanProcessor
      - Exporter: OTLPSpanExporter from opentelemetry-exporter-otlp-proto-http
                  (default Content-Type: application/x-protobuf)
                  pointed at `${endpoint}/v1/otlp/v1/traces`
    Safe to call multiple times — second call updates the resource attrs, does not re-install processors.
    """
```

Idempotent because LiveKit Agents respawns the entrypoint per job via forkserver — `xray.init()` may be called once at module import and once per job.

**Why protobuf, not JSON:** the stock OTel HTTP exporter only ships a protobuf body format. There is no first-party JSON HTTP exporter on PyPI. xray's receiver accepts both (`otlp.router.ts` branches on Content-Type), so protobuf is the path of least resistance — drops the hand-rolled `MessageToJson` exporter and the `protobuf` JSON dependency. Spans on the wire are protobuf bytes (less debuggable via tcpdump but normal for OTLP).

**Baggage processor:** OTel SDK ≥1.27 ships a `BaggageSpanProcessor` upstream — use it instead of the hand-rolled `XrayBaggageSpanProcessor`. Configure with a key filter so only `xray.*` baggage keys are lifted onto spans (avoids leaking arbitrary dev-side baggage into spans).

**`force_flush` caveat:** `BatchSpanProcessor.force_flush(timeout_millis)` blocks until the export queue drains. The `timeout_millis` argument is currently ignored by the upstream SDK (open issue #4568). Practical impact: if the xray server is unresponsive at `xray.bind_replay()` context exit, the worker will hang on the flush call. Mitigation in this PR: document this in the function's docstring; the dev can wrap the `async with` in `asyncio.wait_for(...)` if they need a hard ceiling. A real timeout lands when the upstream PR (#4982) merges.

#### `xray.bind_replay(...)`

```python
@asynccontextmanager
async def bind_replay(
    source: JobContext | None = None,
    *,
    replay_id: str | None = None,
    conversation_id: str | None = None,
    conversation_version: str | None = None,
) -> AsyncIterator[ReplaySession | None]:
    """
    Activates the replay context on the current OTel baggage so every span
    emitted inside the block carries xray.replay.id (+ conversation_id, version).

    Source resolution:
      - source is a LiveKit JobContext → read ctx.room.local_participant.attributes['xray']
        (JSON-encoded {replay_id, conversation_id, conversation_version, modality}).
        If the attribute is missing, no xray-tagged participant joined — yield None.
      - source is None and replay_id is given → use the explicit args (non-LiveKit path).
      - both → ValueError.

    On exit:
      - tracer_provider.force_flush(timeout=5_000) so spans drain before the worker shuts down.
    """
```

Yields `ReplaySession | None`. None means "no xray context present" (production / no test running); the dev's `async with` body still runs unchanged.

#### `@xray.observe(...)`

```python
def observe(
    name: str | None = None,
    *,
    capture_args: bool = True,
    capture_return: bool = True,
    capture_exceptions: bool = True,
) -> Callable[[F], F]:
    """
    Decorator. Wraps a sync OR async function in an OTel span named `name` (default: qualname).
    Span attributes set on success:
      - xray.observe.input  = JSON-encoded args (positional + keyword) — capture_args
      - xray.observe.output = JSON-encoded return value — capture_return
      - duration_ms (from span start/end)
    On exception (capture_exceptions=True):
      - span.record_exception(e) + span.set_status(ERROR)
    """
```

**Manual enrichment** (Langfuse parity):

```python
xray.update_current_span(input={"q": "..."}, output={...}, metadata={...})
```

Writes to span attributes on the active span (looks up via `opentelemetry.trace.get_current_span()`).

Args/return serialization: `json.dumps(default=str)` for safety. Documented limitation — non-JSONable args are stringified.

### 5.3 LiveKit driver — wall-clock stereo capture (rewrite)

`sdk/python/src/xray/runtime/livekit.py`. The existing driver already writes a stereo WAV via `write_stereo_mixdown` at `livekit.py:653`, but it's **turn-sequential** — each turn's PCM is written on its side with silence padded on the other, then concatenated. This loses the real conversation timing (agent latency, barge-in) and is rewritten in this PR to be wall-clock-aligned.

**New capture mechanism:**

1. Driver connects to room as `xray-driver` participant. Mints JWT with `xray` attribute set to `{replay_id, conversation_id, conversation_version, modality: "voice"}`.
2. At connect time, anchor `t0 = time.monotonic()`. All subsequent timestamps are relative to `t0`.
3. **Subscribe (right channel — agent):** `AudioStream(track, sample_rate=48000, num_channels=1)`. Iterate frames in a background task. For each received frame, capture:
   - `recv_at = time.monotonic() - t0`
   - `pcm = bytes(event.frame.data)` (int16 LE)
   - Append `(recv_at, pcm)` to `_agent_frames`. (LiveKit doesn't expose a per-frame timestamp — `time.monotonic()` at receive moment is the only signal. Verified by the livekit-rtc spike.)
4. **Publish (left channel — user):** Driver synthesizes user PCM from `Turn.user.audio` refs (`RecordedAudio` path read from disk, `TtsAudio` synthesized via OpenAI TTS). For each 20ms chunk pushed via `audio_source.capture_frame(...)`:
   - `pub_at = time.monotonic() - t0` measured **just before** `capture_frame`.
   - Append `(pub_at, pcm)` to `_user_frames`.
5. **End of conversation — `audio_recording_path()`:**
   - Compute `total_duration_ms = max(last user pub_at + frame duration, last agent recv_at + frame duration)`.
   - Allocate two int16 buffers of size `total_duration_ms * 48` samples each (48 samples per ms at 48kHz).
   - For each `(pub_at, pcm)` in `_user_frames`: copy into the left buffer at offset `int(pub_at * 48)` samples.
   - For each `(recv_at, pcm)` in `_agent_frames`: copy into the right buffer at offset `int(recv_at * 48)` samples.
   - Gaps stay as zero-init silence; overlap (same offset on both channels) is naturally preserved.
   - Interleave into a stereo PCM buffer, write to a temp WAV via the same `wave` module today's `write_stereo_mixdown` uses.
6. Orchestrator (`xray.run`) calls `driver.audio_recording_path()` and POSTs the file via multipart to `/v1/replays/:id/audio`.

**Tolerance.** `time.monotonic()` granularity is ~1µs on modern OSes. Per the spike, LiveKit's publish path takes the bytes verbatim with no re-encoding (`AudioSource.capture_frame` queues raw int16 directly into the FFI pipeline). Drift between our `pub_at` timestamp and what LiveKit actually transmitted is bounded by the Python → FFI queue latency, typically <1ms. Document this tolerance: ±20ms in `audio.vad.ts` comments and tests.

**Removed code:** `write_stereo_mixdown` (the turn-sequential builder) and its callers (`_write_mixdown`, the segment-walking loop). The per-turn `segment.pcm` accumulators are repurposed to feed the timestamped frame lists above; the per-turn metadata (start/end timestamps, transcript) is no longer needed for the audio file but stays on the driver result for backward compat with the orchestrator return shape until the next PR cleans it up.

**Driver ABC** (`sdk/python/src/xray/runtime/base.py`):

```python
class Driver(ABC):
    @abstractmethod
    async def run_conversation(self, conv: Conversation, *, replay_id: str) -> None: ...

    @abstractmethod
    def audio_recording_path(self) -> Path: ...
    # NEW: replaces today's mixdown WAV behavior with explicit stereo contract.
    # Must point to a 48kHz int16 stereo WAV; left=user-side, right=agent-side.
```

### 5.4 `xray.run(...)` — orchestrator

```python
async def run(
    *,
    conversation: Conversation,
    driver: Driver,
    xray_url: str,                         # http://localhost:8080
    run_config: RunConfig | None = None,
    wait_timeout_seconds: float = 300.0,
) -> ReplayResult:
    """
    Steps:
      1. POST /v1/conversations — upsert (idempotent)
      2. POST /v1/replays  — eager row, returns replay_id
      3. await driver.run_conversation(conversation, replay_id=replay_id)
      4. POST /v1/replays/:id/audio  — multipart, the stereo WAV at driver.audio_recording_path()
      5. POST /v1/replays/:id/analyze  — enqueue server-side job
      6. GET /v1/replays/:id/events  — SSE stream; consume until lifecycle_state is terminal
      7. GET /v1/replays/:id  — fetch final detail
      8. Return ReplayResult (lifecycle_state, failure_reason, replay_id, url, turns, segments)
    Raises AnalysisFailedError on lifecycle_state == 'failed'.
    Raises TimeoutError on wait_timeout_seconds exceeded (driver does NOT cancel the server job).
    """
```

`ReplayResult` shape this PR (assertions removed):

```python
@dataclass(frozen=True)
class ReplayResult:
    replay_id: str
    url: str                       # f"{xray_url}/replays/{replay_id}"
    lifecycle_state: Literal["completed", "failed"]
    failure_reason: str | None
    turns: tuple[ResultTurn, ...]   # derived turn boundaries + segments per turn
```

---

## 6 · File layout — full diff summary

**New slices:**
- `src/server/jobs/` — bunqueue wrapper + analyze-replay job
- `src/server/audio/` — VAD, WAV reader, turn derivation
- `src/server/replays/replays.events.ts` — SSE event stream (inside existing slice)

**Modified slices:**
- `src/server/store/schema.ts` — full rewrite (drop+recreate)
- `src/server/store/migrations/` — wiped, regenerated
- `src/server/replays/replays.router.ts` — new POST `/analyze`, GET `/events`
- `src/server/replays/replays.service.ts` — lifecycle transitions, event emitter
- `src/server/replays/replays.types.ts` — new lifecycle enum, removed judge/meta types
- `src/server/otlp/vocabularies/xray.ts` — remove `xray.turn` extraction

**Deleted:**
- `src/server/store/schema.ts` `replay_meta` and `assertions` tables (folded / dropped)
- old turn-extraction logic in OTLP vocab

**Python SDK new files:**
- `sdk/python/src/xray/init.py`
- `sdk/python/src/xray/binding.py`
- `sdk/python/src/xray/observe.py`
- `sdk/python/src/xray/events.py`

**Python SDK deleted:**
- `sdk/python/src/xray/instrument.py`
- `sdk/python/src/xray/otel.py` (job folded into stdlib OTel SDK calls)

---

## 7 · Risks and research spikes

| # | Risk | Mitigation |
|---|---|---|
| 1 | Pure-JS energy VAD has lower accuracy than libfvad / Silero. False positives on noisy backgrounds, false negatives on quiet TTS voices. | Configurable energy threshold per replay via `run_config.vad_energy_threshold` + global env `XRAY_VAD_ENERGY_THRESHOLD`. Test fixture suite covers known-clean, known-noisy, and known-quiet inputs. If accuracy bites in real use, drop in a Silero-VAD adapter behind the same `runVadOnChannel(...)` signature — interface is stable. |
| 2 | bunqueue@2.7.12 is an actively-shaken-out project (213 versions in 4 months, single maintainer). | Pinned to exact version, no `^` range. Lockfile-frozen. If a critical CVE / abandonment happens, fallback is a ~150-LOC in-`xray.db` job table — small enough to ship in a hotfix. |
| 3 | bunqueue opens a second SQLite file under `/data/`. Slight tension with `single-image-distribution.md`. | Documented in §4.2. Single volume, two files, no second container. Acceptable. |
| 4 | LiveKit Python provides no per-frame timestamp on received audio (verified by spike). Driver's wall-clock alignment uses `time.monotonic()` at publish/receive time. Drift between our timestamp and what LiveKit actually transmitted is bounded by Python→FFI queue latency. | Document tolerance: ±20ms. Use `time.monotonic()` for both publish and receive sides anchored at `t0` from `room.connect()`. Add a loopback test fixture (driver publishes a known sine, captures the agent-side echo, asserts delta < 20ms). |
| 5 | SSE through corporate proxies / Cloudflare can buffer responses. | Heartbeat `:\n\n` every 15s via `stream.write(": heartbeat\\n\\n")`. Documented as a known limit; long-poll fallback is a follow-up PR if a real user hits it. |
| 6 | `@xray.observe(capture_args=True)` may leak PII into spans. | `capture_args` and `capture_return` are opt-out per-call. Documentation example shows turning them off on sensitive functions. Future PR could add a global redactor. |
| 7 | `BatchSpanProcessor.force_flush(timeout_millis)` ignores its timeout argument upstream (issue #4568). If the xray server is down at worker exit, `xray.bind_replay()`'s exit hangs. | Document in docstring. Dev wraps in `asyncio.wait_for(...)` if a hard ceiling is needed. Real timeout lands when upstream PR #4982 merges. |
| 8 | Wall-clock-aligned stereo capture replaces the existing turn-sequential mixdown. Existing test `test_runtime_captures_agent_turn_via_transcription` asserts frame counts against the sequential format. | Rewrite the test fixtures + assertions for the new format. Add new tests for barge-in (overlap on both channels) and agent-latency (gap on both channels). |

---

## 8 · Test plan (TDD per `.claude/rules/tdd.md`)

**Server:**
- `src/server/audio/audio.vad.test.ts` — known WAV → known segments, multiple aggressiveness levels.
- `src/server/audio/audio.turns.test.ts` — synthetic segment timelines → expected turn boundaries; cover overlap, single-side silence, leading/trailing silence, micro-segments below threshold.
- `src/server/jobs/jobs.bunqueue.test.ts` — embedded bunqueue: enqueue → process → completed event fires. Worker restart between enqueue and process → recovery requeues.
- `src/server/jobs/analyze-replay/analyze-replay.processor.test.ts` — end-to-end with a fixture stereo WAV: enqueue → DB rows in `speech_segments` and `replay_turns` after completion.
- `src/server/replays/replays.events.test.ts` — SSE subscriber receives `state`, `progress`, terminal events in order; heartbeat fires; stream closes on terminal.
- `src/server/replays/replays.router.test.ts` — `POST /analyze` requires `recording_uploaded`, returns `202 + job_id`, transitions lifecycle; rejects double-analyze.

**SDK (Python):**
- `sdk/python/tests/init_test.py` — `xray.init()` idempotent; reads endpoint from env; resource attrs land on a probe span.
- `sdk/python/tests/binding_test.py` — `bind_replay(ctx)` reads JWT attr; `bind_replay(replay_id=...)` honors explicit; baggage propagates; force_flush on exit.
- `sdk/python/tests/observe_test.py` — sync function: args/return captured, exception captured; async function: same; opt-out flags honored.
- `sdk/python/tests/livekit_driver_test.py` — feeds fake PCM into capture, asserts produced WAV has expected stereo layout, sample rate, duration. (No live LiveKit room — driver internals exposed via a `_capture` testing seam.)
- `sdk/python/tests/orchestrator_test.py` — orchestrator hits a mock xray server (fixture Hono app available via the same project's HTTP fixtures? if not, use httpx-mock); covers the full sequence and SSE wait.

---

## 9 · Sequencing — concrete commit plan

Single branch, multiple commits. Suggested order (each commit green; rebases freely):

1. **schema rewrite** — new tables, drop migrations, regen via `drizzle generate`. Tests for store ops pass on the new schema. Read endpoints return new shape (frontend breaks here — accepted).
2. **bunqueue integration** — add `bunqueue@2.7.12`, slice `src/server/jobs/`, embedded round-trip test green. No analyze logic yet.
3. **audio slice + VAD** — WAV reader, VAD wrapper, turn derivation. Pure-function tests against fixture WAVs.
4. **`POST /v1/replays/:id/analyze` + processor** — wires bunqueue + audio slice. Lifecycle transitions written. Fixture-driven E2E test (upload WAV → analyze → assert rows).
5. **SSE `/events`** — event emitter in service layer, SSE response in router, subscriber test.
6. **OTLP receiver: remove `xray.turn` extraction** — small, isolated. Test vocabulary registry no longer extracts turns.
7. **Python SDK module restructure** — delete `instrument.py` / `otel.py`, add `init.py` / `binding.py` / `observe.py` / `events.py`. Tests cover each. `__init__.py` exports updated.
8. **LiveKit driver — local stereo capture** — replaces mixdown WAV path. Tests via injected fake PCM.
9. **Orchestrator update** — new `xray.run` flow (upload → analyze → SSE wait). Mock-server test.
10. **Drop assertions + judge from SDK** — `Conversation.Turn.agent(assertion=...)` accepted at call site for back-compat but ignored with `DeprecationWarning`; orchestrator no longer evaluates them; `ReplayResult.assertions` removed. (We keep accepting the kwarg to avoid breaking the user's existing example file in this PR; full removal in the assertion-resync follow-up PR.)
11. **Docs** — update `docs/architecture.md` + `docs/integrate.md` to the new flow. New endpoint table. New diagrams.
12. **`CLAUDE.md` updates** — sync the "primary audience" and "SDK" sections to the new module map.

Estimated total: substantial but tractable single PR. Each commit is reviewable in isolation. If the PR feels too big at review time, splitting commits 1–6 (server) and 7–10 (SDK) into two PRs is a free move — they share no source files.

---

## 10 · Open questions (resolved during spike phase)

The pre-implementation spikes (see preamble) closed all major architectural unknowns. Remaining items, all low-stakes and decidable during implementation:

1. **Energy VAD threshold tuning** — defaults will be calibrated against fixture WAVs in `audio.vad.test.ts`. If real-world recordings need different defaults, the env / `run_config` overrides land first.
2. **Driver-side TtsAudio capture timing** — spike confirmed publish-side capture is fine (no surprise re-encoding by LiveKit). Implement against `audio_source.capture_frame` boundary; document tolerance.
3. **SSE retry behavior on the SDK side** — Spec defaults to no client-side reconnect. Driver wraps the SSE loop in a single attempt + `TimeoutError`. Flag if real test runs hit transient drops.
4. **`xray.observe` for generators / async generators** — out of scope v0. Decorator raises `TypeError` if a generator function is wrapped.
5. **bunqueue `progress` event listener gets `job: Job<T> | null`** — the null case appears during shutdown / cancellation. Spec'd handler short-circuits when `job === null`.

---

## 11 · What this PR does NOT change

For reviewers' sanity, an explicit list:

- The single-image distribution model (`docker run ghcr.io/...`).
- The trust boundary (SDK control plane is the only writer of `conversations` + `replays`).
- The OTLP vocabulary registry pattern (one file per vocabulary in `src/server/otlp/vocabularies/`).
- The slice-per-feature code layout.
- Valibot at boundaries; typed errors with `instanceof` narrowing; `ts-pattern` for dispatch.
- bun:sqlite as xray's database library.
- The Conversation spec API (`Turn.user(audio=..., text=..., key=...)` etc.) — a separate PR rebuilds this.
