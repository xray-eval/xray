# xray architecture

This doc is the map for anyone contributing to xray. It explains the
three processes, the two write paths into storage, the read path that
backs the inspector, and the trust boundary between them.

End-user integration instructions live in [`integrate.md`](./integrate.md).

---

## TL;DR

- Three independent processes: the **driver** (test side, Python), the
  **agent worker** (dev's code, Python), and **xray** itself (a single
  Bun process serving SPA + HTTP API + OTLP receiver + a background
  job worker).
- xray has **exactly two write surfaces**: the SDK control plane
  (the driver POSTs Conversations / Replays here, the only trusted
  source for those rows) and the OTLP/HTTP receiver (both sides emit
  spans here; routed by `xray.replay.id`, filtered by vocabulary).
- **Server-side analysis.** The driver uploads a 48kHz int16 stereo
  WAV (left = user, right = agent) on completion. The server runs
  per-channel VAD, derives turn boundaries from the segments, and
  writes `speech_segments` + `replay_turns` rows. The driver waits via
  SSE on `/v1/replays/:id/events`.
- Storage is one **SQLite file** at `/data/xray.db` plus the bunqueue
  job DB at `/data/bunqueue.db`, plus audio bytes on disk under
  `XRAY_AUDIO_ROOT`. No external services. No second container. See
  [`single-image-distribution.md`](../.claude/rules/single-image-distribution.md)
  for why this is non-negotiable.
- The **inspector SPA** is served by the same Bun process that owns
  the API — one image, one port, one volume.

---

## The three processes

```mermaid
flowchart LR
    subgraph DRV["Driver — test side (Python)"]
      direction TB
      D1["<b>xray.run(...)</b><br/>orchestrator<br/>(POSTs control plane,<br/>installs OTLP pipeline,<br/>attaches replay baggage,<br/>waits via SSE)"]
      D2["<b>LiveKitDriver</b><br/>plays user audio,<br/>captures agent audio + transcripts,<br/>writes wall-clock stereo WAV<br/>(L = user, R = agent)"]
      D1 --> D2
    end

    subgraph LK["LiveKit room (audio plane)"]
      LKR["WebRTC audio<br/>+ live transcripts"]
    end

    subgraph AGT["Agent worker — dev's code (Python)"]
      direction TB
      A1["<b>async with xray.attach(ctx)</b><br/>reads JWT 'xray' attribute,<br/>sets OTEL baggage,<br/>installs OTLP pipeline"]
      A2["dev's agent code:<br/>strategy, STT, TTS, tool-calls<br/>emits gen_ai.* + xray.stage.*<br/>(and any other OTEL spans)"]
      A1 --> A2
    end

    subgraph XR["xray — single Bun process"]
      direction TB
      CTL["<b>Control plane</b><br/>POST /v1/conversations<br/>POST /v1/replays<br/>POST /v1/replays/:id/audio<br/>POST /v1/replays/:id/analyze<br/>GET /v1/replays/:id/events (SSE)<br/>PATCH /v1/replays/:id<br/>GET /v1/conversations<br/>GET /v1/replays/:id"]
      OTLP["<b>OTLP receiver</b><br/>POST /v1/otlp/v1/traces<br/>JSON + protobuf<br/><br/>Vocabulary registry:<br/>xray.* + gen_ai.* + Langfuse<br/>routes by xray.replay.id"]
      JOB["<b>bunqueue worker</b><br/>analyze-replay job:<br/>VAD on each channel,<br/>derive turn boundaries,<br/>write replay_turns +<br/>speech_segments"]
      DB[("<b>SQLite</b><br/>/data/xray.db<br/><br/>conversations, replays,<br/>replay_turns, speech_segments,<br/>tool_calls, model_usage, spans")]
      BQDB[("<b>bunqueue DB</b><br/>/data/bunqueue.db<br/>(jobs, DLQ)")]
      AUDIO[("<b>Audio</b><br/>$XRAY_AUDIO_ROOT/<br/>&lt;replay&gt;/replay.wav")]
      SPA["<b>Inspector SPA</b><br/>(React, served via<br/>Bun.serve HTML routes)"]
      CTL --> DB
      CTL --> AUDIO
      CTL --> BQDB
      OTLP --> DB
      JOB --> DB
      JOB --> AUDIO
      JOB --> BQDB
      DB --> SPA
      AUDIO --> SPA
    end

    D1 -- "POST /v1/conversations<br/>POST /v1/replays<br/>POST /audio<br/>POST /analyze<br/>GET /events (SSE)<br/>PATCH /v1/replays/:id" --> CTL
    D2 -- "publish audio track" --> LKR
    D2 -- "xray.turn spans<br/>(raw spans only —<br/>turn boundaries come<br/>from server-side VAD)" --> OTLP
    LKR -- "deliver audio +<br/>live transcripts" --> A2
    A2 -- "gen_ai.* / xray.stage.* /<br/>any OTEL spans" --> OTLP
```

### Why three processes

- The **driver** runs in CI or on the dev's laptop. It owns the test
  spec, plays the user audio, captures the agent audio, writes the
  stereo WAV, uploads it, then waits via SSE for the server to finish
  VAD + turn derivation. It is also the only thing that mints LiveKit
  JWTs carrying the `xray` attribute (replay_id, conversation_hash,
  modality) — that JWT is how the agent side learns which replay
  it's inside.
- The **agent worker** is the dev's own LiveKit Agents code, with one
  thin xray wrapper: `async with xray.attach(ctx, …)`. It runs the
  same way it would in production (because in production, no `xray`
  attribute is on the JWT, and `attach` no-ops). Its job from xray's
  point of view is *to emit OTEL spans*.
- **xray** is the single Bun image that takes both inputs and renders
  the inspector. The analyze-replay job runs in-process via bunqueue
  in `embedded` mode — no second container, no Redis, no separate
  worker process.

The driver and the agent worker **never talk to each other directly**.
They share state through (a) the LiveKit room (audio + JWT attribute),
and (b) xray itself (every span lands under the same `xray.replay.id`).

---

## The two write paths

xray has exactly two write surfaces. Every byte that mutates state in
`/data/xray.db` arrives through one of them. They are coupled by trust:
the OTLP receiver **never** creates Conversation or Replay rows; that
is exclusively the SDK control plane's job.

```mermaid
flowchart TB
    subgraph WRITES["Write surfaces — trust boundary lives here"]
      direction LR
      subgraph CP["Control plane — Valibot-validated, idempotent"]
        CP1["POST /v1/conversations<br/><i>multipart spec + audio bytes<br/>server hashes canonical turns → conversation_hash<br/>upsert by hash (last-write-wins on name)</i>"]
        CP2["POST /v1/replays<br/><i>eager row create — lifecycle_state='pending'<br/>returns replay_id</i>"]
        CP3["POST /v1/replays/:id/audio<br/><i>stereo WAV → XRAY_AUDIO_ROOT<br/>X-Recording-Started-At → replays.recording_started_at<br/>lifecycle_state='recording_uploaded'</i>"]
        CP4["POST /v1/replays/:id/analyze<br/><i>enqueue bunqueue job<br/>lifecycle_state='analyzing'<br/>analysis_step='vad'</i>"]
        CP5["PATCH /v1/replays/:id<br/><i>lifecycle_state / failure_reason / finished_at</i>"]
        CP6["analyze-chain workers<br/><i>analyze-replay: VAD + Whisper → speech_segments + replay_turns + turn_transcripts<br/>calculate-metrics: agent_response_ms + interrupted → replay_metrics<br/>evaluate-replay: assertions + judges → assertion_results + judge_results + replay_evaluations<br/>lifecycle_state='completed' on chain success</i>"]
      end
      subgraph RX["OTLP receiver — filters, not gates"]
        RX1["POST /v1/otlp/v1/traces<br/>JSON or protobuf<br/><br/>Routes by xray.replay.id resource attr.<br/>Unknown replay_id → silent drop.<br/>Unknown vocabulary → silent drop.<br/><br/>Vocabularies in src/server/otlp/vocabularies/:<br/>• xray.ts (xray.* recognized, raw spans only)<br/>• gen-ai-semconv.ts (gen_ai.* per OTel)<br/>• langfuse.ts (Langfuse-flavoured GenAI)"]
      end
    end

    subgraph TABLES["SQLite rows (/data/xray.db)"]
      direction LR
      T_C[("conversations")]
      T_R[("replays")]
      T_RT[("replay_turns")]
      T_SS[("speech_segments")]
      T_TC[("tool_calls")]
      T_MU[("model_usage")]
      T_S[("spans")]
      T_TT[("turn_transcripts")]
      T_RM[("replay_metrics")]
      T_AR[("assertion_results")]
      T_JR[("judge_results")]
      T_RE[("replay_evaluations")]
    end

    CP1 --> T_C
    CP2 --> T_R
    CP3 --> T_R
    CP4 --> T_R
    CP5 --> T_R
    CP6 --> T_R
    CP6 --> T_RT
    CP6 --> T_SS
    RX1 --> T_TC
    RX1 --> T_MU
    RX1 --> T_S
```

### Control plane (driver only)

`sdk/python/src/xray/orchestrator.py:run(...)` POSTs to these endpoints
in order:

1. `POST /v1/conversations` — Valibot-validated upsert keyed by
   `hash`. Multipart body: a `spec` JSON part with `name` + `turns`,
   plus one named file part per `RecordedAudio` turn keyed by the
   turn's declared `upload_key`. The server reads each audio part,
   sha256s the bytes, substitutes the hash into the canonical turn,
   then hashes the canonical turn JSON to derive `conversation_hash`.
   Re-POSTing the same hash with a different `name` updates the
   row's display label (last-write-wins). The SDK never hashes
   anything.
2. `POST /v1/replays` — creates the Replay row **eagerly** at
   `lifecycle_state='pending'` and returns `replay_id`. This must
   happen before the runtime emits its first span; otherwise the OTLP
   receiver would drop them as "unknown replay_id."
3. `POST /v1/replays/:id/audio` — uploads the stereo WAV (left = user,
   right = agent, wall-clock-aligned, written under
   `XRAY_AUDIO_ROOT/<replay_id>/replay.<ext>`). The server flips
   `lifecycle_state` to `recording_uploaded`.
4. `POST /v1/replays/:id/analyze` — enqueues the bunqueue
   `analyze-replay` job. The server transitions to
   `lifecycle_state='analyzing'` with `analysis_step='vad'`. Returns
   `202 Accepted` with the bunqueue job id.
5. `GET /v1/replays/:id/events` (SSE) — the SDK streams `state`,
   `progress`, `evaluation_complete`, and `failed` events. The
   `evaluation_complete` payload carries the full `ReplayResult`
   (passed/failed verdict + per-assertion + per-judge + per-turn
   metrics) so the SDK can return immediately without a follow-up GET.
   Heartbeat `:` line every 15s keeps proxies from idling out. SDK
   closes the stream when `lifecycle_state` hits a terminal value.
6. `GET /v1/replays/:id/result` — same `ReplayResult` payload outside
   the SSE stream for late subscribers / inspector hydration.
7. `PATCH /v1/replays/:id` — only used by the SDK for driver-side
   failures (`failure_reason='driver_aborted'` / `audio_missing` /
   `agent_not_joined`). Lifecycle transitions during the analyze chain
   are server-owned.

### OTLP receiver (both sides)

`src/server/otlp/otlp.service.ts` accepts both `application/json` and
`application/x-protobuf`, normalises to a JSON-shape that the
Valibot schema validates, then dispatches each span through the
vocabulary registry (`src/server/otlp/vocabularies/registry.ts`).

Each registered vocabulary is one file. To add a new one (e.g. a
provider-specific semconv), drop a file in `vocabularies/` plus one
line in `registry.ts`. The receiver is a **filter, not a gate**:
- Unknown vocabulary → silently dropped (so an agent worker emitting
  noisy framework spans doesn't pollute storage).
- Unknown `xray.replay.id` → silently dropped (so an agent running in
  production, where there is no replay context, doesn't write rows).

**xray vocabulary** (`src/server/otlp/vocabularies/xray.ts`) — recognized
span names: `xray.turn`, `xray.stage.stt`, `xray.stage.tts`. They land
in the raw `spans` table for the inspector's timeline but produce no
structured rows — turn boundaries come from server-side VAD, and
assertion + judge outcomes come from the server's evaluate-replay job
walking the declared catalog. `xray.assertion` and `xray.judge` are no
longer recognized: the spec-0001 server reads its checks from the
`Assertion` / `Judge` variants declared on the conversation, not from
driver-emitted spans.

**Tool / model → turn attribution** is timestamp-based, not span-tag
based — and derived, not stored. `tool_calls` / `model_usage` rows carry
only their wall-clock `started_at`; turn membership is computed at
eval/read time by mapping `started_at` onto the audio timeline
(`audio_offset_ms = started_at − replays.recording_started_at`, the
anchor the driver sends via the `X-Recording-Started-At` upload header)
and testing the VAD-derived turn window `[turn_start_ms, turn_end_ms)`.
There is no `turn_idx` column on those tables and no backfill stage —
see `docs/specs/0001-timeline-clock-alignment.md` for why
`replays.started_at` (row-creation time) must never be used as the
origin.

**gen_ai semconv** (`gen-ai-semconv.ts`) — `gen_ai.tool` → `tool_calls`,
`gen_ai.client.operation` → `model_usage`. **Langfuse** vocabulary
(`langfuse.ts`) extracts the same shapes from Langfuse-flavoured GenAI.

---

## Replay lifecycle (single replay, time order)

```mermaid
sequenceDiagram
    autonumber
    participant D as Driver<br/>(xray.run)
    participant X as xray
    participant W as analyze-replay<br/>worker
    participant LK as LiveKit room
    participant A as Agent worker<br/>(xray.attach)

    D->>X: POST /v1/conversations<br/>(upsert spec, turns_json)
    D->>X: POST /v1/replays<br/>→ replay_id<br/>(lifecycle_state='pending')
    D->>D: install OTLP pipeline<br/>+ attach replay baggage
    D->>LK: connect, mint JWT carrying<br/>xray attribute = {replay_id,<br/>conversation_hash, modality}
    A->>LK: connect (agent worker joins room)
    A->>A: xray.attach reads JWT 'xray' attribute<br/>→ sets baggage, installs OTLP pipeline

    loop each turn in conversation.turns
      alt user turn
        D->>LK: publish user audio<br/>(captured into L channel<br/>at wall-clock offset)
        LK->>A: deliver user audio
      else agent turn
        A->>A: STT → strategy → tool-calls → TTS
        A->>X: gen_ai.* spans, xray.stage.* spans, ...
        A->>LK: publish agent audio
        LK->>D: capture agent audio<br/>into R channel<br/>at wall-clock offset
      end
    end

    D->>D: assemble stereo WAV<br/>(L = user PCM, R = agent PCM,<br/>wall-clock-aligned)
    D->>X: POST /v1/replays/:id/audio<br/>+ X-Recording-Started-At (audio t=0)<br/>→ lifecycle_state='recording_uploaded'
    D->>X: POST /v1/replays/:id/analyze<br/>→ lifecycle_state='analyzing'
    X->>W: bunqueue enqueue analyze-replay
    W->>W: read WAV, downsample to 16k,<br/>VAD per channel,<br/>derive turn boundaries
    W->>X: insert speech_segments + replay_turns<br/>analysis_step='transcribe'
    W->>W: slice per-turn audio, call Whisper<br/>(Promise.all over turns)
    W->>X: insert turn_transcripts<br/>enqueue calculate-metrics
    X->>W: bunqueue enqueue calculate-metrics
    W->>W: compute agent_response_ms<br/>+ interrupted per turn
    W->>X: insert replay_metrics<br/>analysis_step='evaluate'<br/>enqueue evaluate-replay
    X->>W: bunqueue enqueue evaluate-replay
    W->>W: run each declared Assertion<br/>(pure ts-pattern dispatch)<br/>+ each declared Judge<br/>(OpenAI Chat Completions)
    W->>X: insert assertion_results + judge_results + replay_evaluations<br/>lifecycle_state='completed'
    X-->>D: SSE 'evaluation_complete' event<br/>(full ReplayResult payload)
```

Two things to notice in this diagram:

- **The audio plane (LiveKit) and the observability plane (OTLP) are
  separate.** Audio never goes through xray during the run; xray just
  receives the post-hoc stereo WAV. The agent worker's STT is the
  dev's STT — xray sees only its emitted OTEL spans.
- **The replay row is created _before_ any spans land.** This is what
  makes the OTLP receiver's "unknown replay_id → drop" rule safe: by
  the time the agent worker emits its first span, the Replay row
  already exists, so the receiver routes the span correctly.

---

## Storage

```mermaid
erDiagram
    conversations ||--o{ replays : "(conversation_hash)"
    replays ||--o{ replay_turns : "replay_id"
    replays ||--o{ speech_segments : "replay_id"
    replays ||--o{ tool_calls : "replay_id"
    replays ||--o{ model_usage : "replay_id"
    replays ||--o{ spans : "replay_id (raw OTLP)"
    replays ||--o{ turn_transcripts : "replay_id (Whisper)"
    replays ||--o{ replay_metrics : "replay_id (timing)"
    replays ||--o{ assertion_results : "replay_id (evaluation)"
    replays ||--o{ judge_results : "replay_id (evaluation)"
    replays ||--|| replay_evaluations : "replay_id (verdict)"

    conversations {
        text hash PK "SHA-256 of canonical turn JSON (incl. sha256 of RecordedAudio bytes)"
        text name "Free-form display label; last-write-wins on re-POST"
        text turns_json "JSON-encoded canonical turn array — the hash input"
        text created_at
        text last_run_at "Bumped on every POST /v1/conversations"
    }
    replays {
        text id PK
        text conversation_hash FK
        text lifecycle_state "pending | running | recording_uploaded | analyzing | completed | failed"
        text analysis_step "vad | turns | null"
        text failure_reason "stalled | timeout | explicit_fail | max_attempts_exceeded | worker_lost | upload_failed | driver_aborted | null"
        text started_at
        text finished_at
        text audio_path "relative path under XRAY_AUDIO_ROOT to the stereo WAV"
        text run_config_json
        text job_id "bunqueue job id (null before /analyze)"
    }
    replay_turns {
        text replay_id PK,FK
        int idx PK
        text role "user | agent"
        int turn_start_ms "turn boundary: directly after other side's last segment ended"
        int turn_end_ms "turn boundary: this side's last segment in the turn ended"
        int voice_start_ms "voice-active boundary: first speech in this turn"
        int voice_end_ms "voice-active boundary: last speech in this turn"
    }
    speech_segments {
        int id PK
        text replay_id FK
        text channel "user | agent"
        int start_ms "offset from t=0 in the recording"
        int end_ms
    }
```

`replay_turns` is the join point between the spec
(`conversations.turns_json`) and the observed execution. Rows are
written by the `analyze-replay` worker after running VAD on each
channel of the uploaded stereo WAV. `speech_segments` carries the raw
VAD output (one row per detected voiced chunk per channel); the
inspector renders these alongside the turn boundaries for debugging
overlap / silence / latency.

`tool_calls`, `model_usage`, and `spans` are written by the OTLP
receiver as it ingests `gen_ai.*` / Langfuse / `xray.*` spans.

---

## Read path — what the inspector sees

The inspector (`src/client/inspector/` + slice folders under
`src/client/`) is a React SPA bundled by Bun's HTML bundler and
served by the same Bun process that owns the API. There is **no
client-side build step in CI**; Bun builds it at request time and at
container start.

```mermaid
flowchart LR
    UI["Inspector SPA<br/>(React)"]
    EP1["GET /v1/conversations<br/>GET /v1/conversations/:hash"]
    EP2["GET /v1/conversations/:hash/replays<br/>(every replay for this hash)"]
    EP3["GET /v1/replays/:id<br/>(buildReplayDetail — the<br/>big join)"]
    EP4["POST /v1/replays/compare<br/>(body: 2–8 replay ids)"]
    EP5["GET /v1/replays/:id/audio<br/>(stereo WAV bytes)"]
    EP6["GET /v1/replays/:id/events<br/>(SSE — live progress)"]

    UI --> EP1
    UI --> EP2
    UI --> EP3
    UI --> EP4
    UI --> EP5
    UI --> EP6

    EP3 -. "joins<br/>replays + replay_turns + speech_segments<br/>+ tool_calls + model_usage + spans" .-> DB[("SQLite")]
    EP5 -. "streams<br/>WAV bytes" .-> AUDIO[("XRAY_AUDIO_ROOT")]
```

Every read endpoint is in `src/server/<slice>/<slice>.router.ts`. The
service layer (`<slice>.service.ts`) does the actual SQL via Drizzle
on `bun:sqlite`. The slice convention is documented in
[`code-layout.md`](../.claude/rules/code-layout.md).

---

## Distribution

Shipped artifact: a Docker image published to GHCR
(`ghcr.io/xray-eval/xray`) by CI on tagged releases. Operators run

```
docker run -v ./data:/data -e XRAY_AUDIO_ROOT=/data/audio ghcr.io/xray-eval/xray
```

and that is the install. The image carries the Bun process, the
pre-built SPA, the SQLite schema (migrated at startup), the bunqueue
worker (embedded, same process), and nothing else. No SaaS. No hosted
version. No second container.

This single-image promise is load-bearing for several other choices
in the codebase (SQLite over Postgres, `bun:sqlite` over a network
driver, embedded reads over a separate query service, embedded
bunqueue worker over a separate queue process). See
[`single-image-distribution.md`](../.claude/rules/single-image-distribution.md)
before proposing any change that would break it.

**Two SQLite files in `/data/`.** xray owns `xray.db` (conversations,
replays, etc.). bunqueue owns `bunqueue.db` (jobs, DLQ). Acknowledged
tradeoff vs the "one file" reading of the rule — single volume, two
files, no second process. Operator backs up the whole `/data` volume.
Path is configurable via `BUNQUEUE_DATA_PATH`.
