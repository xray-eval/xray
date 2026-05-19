# xray architecture

This doc is the map for anyone contributing to xray. It explains the
three processes, the two write paths into storage, the read path that
backs the inspector, and the trust boundary between them.

End-user integration instructions live in [`integrate.md`](./integrate.md).

---

## TL;DR

- Three independent processes: the **driver** (test side, Python), the
  **agent worker** (dev's code, Python), and **xray** itself (a single
  Bun process serving SPA + HTTP API + OTLP receiver).
- xray has **exactly two write surfaces**: the SDK control plane
  (the driver POSTs Conversations / Replays here, the only trusted
  source for those rows) and the OTLP/HTTP receiver (both sides emit
  spans here; routed by `xray.replay.id`, filtered by vocabulary).
- Storage is one **SQLite file** at `/data/xray.db` plus audio bytes
  on disk under `XRAY_AUDIO_ROOT`. No external services. No second
  container. See [`single-image-distribution.md`](../.claude/rules/single-image-distribution.md)
  for why this is non-negotiable.
- The **inspector SPA** is served by the same Bun process that owns
  the API — one image, one port, one volume.

---

## The three processes

```mermaid
flowchart LR
    subgraph DRV["Driver — test side (Python)"]
      direction TB
      D1["<b>xray.run(...)</b><br/>orchestrator<br/>(POSTs control plane,<br/>installs OTLP pipeline,<br/>attaches replay baggage)"]
      D2["<b>LiveKitDriver</b><br/>plays user audio,<br/>emits xray.turn role=user span,<br/>captures mixdown WAV"]
      D1 --> D2
    end

    subgraph LK["LiveKit room (audio plane)"]
      LKR["WebRTC audio<br/>+ live transcripts"]
    end

    subgraph AGT["Agent worker — dev's code (Python)"]
      direction TB
      A1["<b>async with xray.attach(ctx)</b><br/>reads JWT 'xray' attribute,<br/>sets OTEL baggage,<br/>installs OTLP pipeline"]
      A2["dev's agent code:<br/>strategy, STT, TTS, tool-calls<br/>emits gen_ai.* + xray.turn role=agent<br/>+ xray.assertion + xray.judge spans"]
      A1 --> A2
    end

    subgraph XR["xray — single Bun process"]
      direction TB
      CTL["<b>Control plane</b><br/>POST /v1/conversations<br/>POST /v1/replays<br/>POST /v1/replays/:id/audio<br/>PATCH /v1/replays/:id<br/>GET /v1/conversations<br/>GET /v1/replays/:id"]
      OTLP["<b>OTLP receiver</b><br/>POST /v1/otlp/v1/traces<br/>JSON + protobuf<br/><br/>Vocabulary registry:<br/>xray.* + gen_ai.* + Langfuse<br/>routes by xray.replay.id"]
      DB[("<b>SQLite</b><br/>/data/xray.db<br/><br/>conversations, replays,<br/>replay_meta, replay_turns,<br/>assertions, tool_calls,<br/>model_usage, spans")]
      AUDIO[("<b>Audio</b><br/>$XRAY_AUDIO_ROOT/<br/>&lt;replay&gt;.wav")]
      SPA["<b>Inspector SPA</b><br/>(React, served via<br/>Bun.serve HTML routes)"]
      CTL --> DB
      CTL --> AUDIO
      OTLP --> DB
      DB --> SPA
      AUDIO --> SPA
    end

    D1 -- "POST /v1/conversations<br/>POST /v1/replays<br/>POST /audio<br/>PATCH /v1/replays/:id" --> CTL
    D1 -. "GET /v1/replays/:id<br/>(enrichment fetch<br/>before assertions)" .-> CTL
    D2 -- "xray.turn role=user span" --> OTLP
    D2 -- "publish audio track" --> LKR
    LKR -- "deliver audio +<br/>live transcripts" --> A2
    A2 -- "gen_ai.* + xray.* spans" --> OTLP
```

### Why three processes

- The **driver** runs in CI or on the dev's laptop. It owns the test
  spec, plays the user audio, evaluates assertions, decides
  pass/fail. It is also the only thing that mints LiveKit JWTs
  carrying the `xray` attribute (replay_id, conversation_id,
  conversation_version, modality) — that JWT is how the agent side
  learns which replay it's inside.
- The **agent worker** is the dev's own LiveKit Agents code, with one
  thin xray wrapper: `async with xray.attach(ctx, …)`. It runs the
  same way it would in production (because in production, no xray
  attribute is on the JWT, and `attach` no-ops). Its job from xray's
  point of view is *to emit OTEL spans*.
- **xray** is the single Bun image that takes both inputs and renders
  the inspector. No background workers. No queue. No second
  container.

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
        CP1["POST /v1/conversations<br/><i>upsert spec (id, version) → turns_json</i><br/>VersionFingerprintMismatchError on conflict"]
        CP2["POST /v1/replays<br/><i>eager row create — returns replay_id<br/>before any span exists</i>"]
        CP3["POST /v1/replays/:id/audio<br/><i>mixdown WAV → XRAY_AUDIO_ROOT</i>"]
        CP4["PATCH /v1/replays/:id<br/><i>final status + judge<br/>(after driver evaluates assertions)</i>"]
      end
      subgraph RX["OTLP receiver — filters, not gates"]
        RX1["POST /v1/otlp/v1/traces<br/>JSON or protobuf<br/><br/>Routes by xray.replay.id resource attr.<br/>Unknown replay_id → silent drop.<br/>Unknown vocabulary → silent drop.<br/><br/>Vocabularies in src/server/otlp/vocabularies/:<br/>• xray.ts (xray.turn, xray.assertion, xray.judge, xray.stage)<br/>• gen-ai-semconv.ts (gen_ai.* per OTel)<br/>• langfuse.ts (Langfuse-flavoured GenAI)"]
      end
    end

    subgraph TABLES["SQLite rows"]
      direction LR
      T_C[("conversations")]
      T_R[("replays + replay_meta")]
      T_RT[("replay_turns")]
      T_A[("assertions")]
      T_TC[("tool_calls")]
      T_MU[("model_usage")]
      T_S[("spans")]
    end

    CP1 --> T_C
    CP2 --> T_R
    CP4 --> T_R
    RX1 --> T_RT
    RX1 --> T_A
    RX1 --> T_TC
    RX1 --> T_MU
    RX1 --> T_S
```

### Control plane (driver only)

`sdk/python/src/xray/orchestrator.py:run(...)` POSTs to four endpoints
in order:

1. `POST /v1/conversations` — Valibot-validated upsert keyed by
   `(id, version)`. The SDK auto-computes `version` as a fingerprint
   over the canonical turn structure; the server rejects a same-key
   upsert with a different fingerprint as `VersionFingerprintMismatchError`.
2. `POST /v1/replays` — creates the Replay row **eagerly** and
   returns `replay_id`. This must happen before the runtime emits
   its first span; otherwise the OTLP receiver would drop them as
   "unknown replay_id."
3. `POST /v1/replays/:id/audio` — uploads the mixdown WAV (driver's
   captured user audio left-channel + captured agent audio
   right-channel, written to `XRAY_AUDIO_ROOT`).
4. `PATCH /v1/replays/:id` — final status + judge result, after the
   driver evaluates per-turn assertions and the per-replay judge.

### OTLP receiver (both sides)

`src/server/otlp/otlp.service.ts` accepts both `application/json` and
`application/x-protobuf`, normalises to a JSON-shape that the
existing Valibot schema validates, then dispatches each span through
the vocabulary registry (`src/server/otlp/vocabularies/registry.ts`).

Each registered vocabulary is one file. To add a new one (e.g. a
provider-specific semconv), drop a file in `vocabularies/` plus one
line in `registry.ts`. The receiver is a **filter, not a gate**:
- Unknown vocabulary → silently dropped (so an agent worker emitting
  noisy framework spans doesn't pollute storage).
- Unknown `xray.replay.id` → silently dropped (so an agent running in
  production, where there is no replay context, doesn't write rows).

The four xray-specific span kinds the registry knows about:
- `xray.turn` (role=user from driver, role=agent from agent worker) →
  `replay_turns` row carrying idx, role, key, transcript, timestamps.
- `xray.assertion` → `assertions` row.
- `xray.judge` → judge fields on `replay_meta`.
- `xray.stage` (stt, tts) → raw span only; surfaced for per-stage
  latency in the inspector.

GenAI semconv (`gen_ai.tool` → `tool_calls`, `gen_ai.client.operation`
→ `model_usage`) flows the same way.

---

## Replay lifecycle (single replay, time order)

```mermaid
sequenceDiagram
    autonumber
    participant D as Driver<br/>(xray.run)
    participant X as xray
    participant LK as LiveKit room
    participant A as Agent worker<br/>(xray.attach)

    D->>X: POST /v1/conversations<br/>(upsert spec, turns_json)
    D->>X: POST /v1/replays<br/>→ replay_id
    D->>D: install OTLP pipeline<br/>+ attach replay baggage
    D->>LK: connect, mint JWT carrying<br/>xray attribute = {replay_id,<br/>conversation_id, version, modality}
    A->>LK: connect (agent worker joins room)
    A->>A: xray.attach reads JWT 'xray' attribute<br/>→ sets baggage, installs OTLP pipeline

    loop each turn in conversation.turns
      alt user turn
        D->>LK: publish user audio
        D->>X: xray.turn span<br/>(role=user, idx, transcript, key)
        LK->>A: deliver user audio
      else agent turn
        A->>A: STT → strategy → tool-calls → TTS
        A->>X: xray.stage.stt span
        A->>X: gen_ai.* tool spans
        A->>X: xray.turn span<br/>(role=agent, observed transcript)
        A->>LK: publish agent audio
        LK->>D: capture agent audio +<br/>live transcripts
      end
    end

    D->>D: tracer_provider.force_flush()<br/>(driver-side spans drain)
    D->>X: POST /v1/replays/:id/audio<br/>(mixdown WAV)
    D->>X: GET /v1/replays/:id<br/>(merge per-turn tool_calls / model_usage /<br/>stage_timings into AgentResponses)
    D->>D: evaluate assertions + judge
    D->>X: PATCH /v1/replays/:id<br/>(final status + judge)
```

Two things to notice in this diagram:

- **The audio plane (LiveKit) and the observability plane (OTLP) are
  separate.** Audio never goes through xray during the run; xray just
  receives the post-hoc mixdown WAV and the OTEL spans. The agent
  worker's STT is the dev's STT — xray sees only its emitted spans.
- **The replay row is created _before_ any spans land.** This is what
  makes the OTLP receiver's "unknown replay_id → drop" rule safe: by
  the time the agent worker emits its first span, the Replay row
  already exists, so the receiver routes the span correctly.

---

## Storage

```mermaid
erDiagram
    conversations ||--o{ replays : "(conversation_id, conversation_version)"
    replays ||--|| replay_meta : "1:1"
    replays ||--o{ replay_turns : "replay_id"
    replays ||--o{ assertions : "replay_id"
    replays ||--o{ tool_calls : "replay_id"
    replays ||--o{ model_usage : "replay_id"
    replays ||--o{ spans : "replay_id (raw OTLP)"

    conversations {
        text id PK
        text version PK
        text turns_json "JSON-encoded spec — full Turn[] incl. user text + audio refs"
        text title
        text created_at
    }
    replays {
        text id PK
        text conversation_id FK
        text conversation_version FK
        text status "running | completed | failed"
        text failure_reason
        text started_at
        text finished_at
        text audio_path "path under XRAY_AUDIO_ROOT to the mixdown WAV"
        text transcript
    }
    replay_meta {
        text replay_id PK,FK
        text modality "voice"
        text judge_status
        int judge_score
        text run_config_json
    }
    replay_turns {
        int id PK
        text replay_id FK
        int idx
        text role "user | agent"
        text key
        text started_at
        text ended_at
        text transcript
        text audio_path
    }
```

`replay_turns` is the join point between the spec (`conversations.turns_json`)
and the observed execution. Each row comes from an `xray.turn` span;
role=user rows are emitted by the driver (LiveKitDriver), role=agent
rows are emitted by the dev's agent worker via the GenAI / xray
vocabulary on the OTLP receiver.

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
    EP1["GET /v1/conversations<br/>GET /v1/conversations/:id"]
    EP2["GET /v1/conversations/:id/replays<br/>(every replay across versions)"]
    EP3["GET /v1/replays/:id<br/>(buildReplayDetail — the<br/>big join)"]
    EP4["POST /v1/replays/compare<br/>(body: 2–8 replay ids)"]
    EP5["GET /v1/replays/:id/audio<br/>GET /v1/replays/:id/turns/:idx/audio"]

    UI --> EP1
    UI --> EP2
    UI --> EP3
    UI --> EP4
    UI --> EP5

    EP3 -. "joins<br/>replays + replay_meta + replay_turns<br/>+ assertions + tool_calls + model_usage<br/>+ spans" .-> DB[("SQLite")]
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
pre-built SPA, the SQLite schema (migrated at startup), and nothing
else. No SaaS. No hosted version. No second container.

This single-image promise is load-bearing for several other choices
in the codebase (SQLite over Postgres, `bun:sqlite` over a network
driver, embedded reads over a separate query service). See
[`single-image-distribution.md`](../.claude/rules/single-image-distribution.md)
before proposing any change that would break it.
