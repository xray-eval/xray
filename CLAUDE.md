# xray

**xray** — open-source, self-hosted replay/eval framework for LiveKit voice agents. Public repo. React + TypeScript SPA bundled by Bun's built-in HTML bundler (no Vite), Hono on Bun for the API + OTLP receiver, Docker (multi-stage) for distribution. One Bun process serves both the SPA shell (via Bun.serve's HTML routes) and the API. No accounts, no telemetry, no external databases.

**Primary audience.** Python developers writing LiveKit voice agents who want to author conversations as code, run them against their agent, and inspect every turn. The hosted-provider adapters and the legacy custom-loop HTTP ingest are gone — alpha covered the rewrite.

**Voice is the primary investment.** Per-turn audio playback, barge-in indicators, per-stage STT/TTS latency, full-replay mixdown — first-class, not afterthoughts.

**Storage.** Conversations, Replays, server-derived `replay_turns` + `speech_segments` (from VAD), per-turn Whisper transcripts (`turn_transcripts`), per-turn timing metrics (`replay_metrics`), per-assertion + per-judge outcomes (`assertion_results`, `judge_results`), the per-replay verdict row (`replay_evaluations`), recognized OTLP spans, and tool-call / model-usage rows live in a single SQLite file at `/data/xray.db` (mounted volume on the container). bunqueue (the embedded job queue) owns a separate `/data/bunqueue.db` file in the same volume — acknowledged tradeoff vs the strict "one file" reading of the single-image rule (single volume, two files, no second process). Both use single-writer `bun:sqlite`, no network driver. Why SQLite is the right choice here is the topic of [`.claude/rules/single-image-distribution.md`](./.claude/rules/single-image-distribution.md).

## The two paths data takes into xray

xray has exactly two write surfaces; both are documented and Valibot-validated at the boundary.

1. **Control plane (the SDK calls these directly).**
   - `POST /v1/conversations` — idempotent upsert of the Conversation spec (turns + per-turn assertions + conversation-level judges) keyed by its content hash. The server computes the hash; the SDK never hashes anything. Same canonical JSON in → same hash → row upsert (last-write-wins on `name`).
   - `POST /v1/replays` — eager Replay-row creation (`lifecycle_state='pending'`). Returns `replay_id` so the SDK can propagate it (LiveKit room metadata → OTEL baggage) BEFORE the dev's agent emits its first span.
   - `POST /v1/replays/:id/audio` — driver uploads the 48kHz int16 **stereo WAV** (L = user, R = agent, wall-clock-aligned). Flips `lifecycle_state` to `recording_uploaded`.
   - `POST /v1/replays/:id/analyze` — enqueues the bunqueue `analyze-replay` job. The server transitions to `lifecycle_state='analyzing'` with `analysis_step='vad'`. **Three-stage chain**: `analyze-replay` (VAD per channel + Whisper transcription per turn + turn_idx backfill on tool_calls/model_usage) → `calculate-metrics` (agent_response_ms, ttft_ms, interrupted) → `evaluate-replay` (runs declared assertions + judges, writes `assertion_results` / `judge_results` / `replay_evaluations`, flips lifecycle to `completed`). Each stage enqueues the next on success; any stage's failure stamps `lifecycle_state='failed'` with a stage-specific `failure_reason`.
   - `GET /v1/replays/:id/events` — SSE stream of `state` / `progress` / `evaluation_complete` / `failed` events. The `evaluation_complete` event carries the full `ReplayResult` payload (verdict + per-assertion + per-judge + per-turn metrics) — the SDK returns immediately without a follow-up GET.
   - `GET /v1/replays/:id/result` — same `ReplayResult` payload outside the SSE stream for late subscribers / inspector hydration.
   - `PATCH /v1/replays/:id` — driver-side failures only (`failure_reason='driver_aborted'` / `audio_missing` / `agent_not_joined`). Lifecycle transitions during the analyze chain are server-owned.

2. **OTLP/HTTP receiver (the dev's agent emits spans).**
   - `POST /v1/otlp/v1/traces` — OpenTelemetry traces (JSON + protobuf). **Filters, not gates**: routes spans by the `xray.replay.id` resource attribute and runs each through a vocabulary registry (`src/server/otlp/vocabularies/`: `xray.*`, OTel GenAI semconv `gen_ai.*`, Langfuse). Unknown vocabularies are dropped silently; unknown replay ids are dropped silently. Extracted fields land in `tool_calls` and `model_usage` with `turn_idx=NULL` (the `analyze-replay` job backfills `turn_idx` by matching the span's `started_at` to a `replay_turns.voice_start_ms..voice_end_ms` window). Every accepted span lands in `spans`. `xray.turn` / `xray.stage.*` are accepted as raw spans only. `xray.assertion` and `xray.judge` are no longer recognized — evaluation runs from the declared `Assertion` / `Judge` catalog.

The two paths are coupled by trust: the OTLP receiver doesn't create Conversation or Replay rows, ever. The trust boundary is the SDK's POST. The analyze chain adds three "internal" write paths — the embedded bunqueue workers writing `replay_turns` + `speech_segments` + `turn_transcripts` + `replay_metrics` + `assertion_results` + `judge_results` + `replay_evaluations` after reading the uploaded WAV + the declared spec.

## Replay = one execution of one Conversation

There is only one meaning of "replay" in this repo now. The old "agent replay" vs "seed replay" split is gone — every Replay is produced by a real driver run against a real agent. A committed snapshot of one such run lives at `snapshot/` so the inspector has authentic data to render without re-executing the example.

## API documentation

- `GET /openapi.json` — OpenAPI 3.1, auto-assembled from `describeRoute(...)` metadata each router declares.
- `GET /docs` — Scalar UI on top of `/openapi.json`.

The shared `OpenAPIV3.SchemaObject` helper lives in `src/server/core/types.ts` alongside cross-slice error-response schemas — both are wire contracts every router slice depends on.

## SDK

The Python SDK lives at [`sdk/python/`](./sdk/python). Public surface:

- `xray.conversation` — test definitions: `Conversation`, `Turn.user(...)`, `Turn.agent(...)`, declarative `Assertion.contains(...)` / `Assertion.tool_called(...)` / `Assertion.max_latency_ms(...)` / etc., and conversation-level `Judge.text_match(...)`. All assertion / judge variants ship on the wire and run **server-side**.
- `xray.runtime` — pluggable driver ABC; `xray.runtime.livekit.LiveKitDriver` is the v1 implementation. Pipecat / OpenAI Realtime / Gemini Live / raw WebSocket are on the roadmap as new sub-modules.
- `xray.attach(ctx)` — async context manager for LiveKit Agents worker entrypoints; reads the JWT's `xray` attribute, installs the OTLP exporter, force-flushes spans on exit.
- `xray.run(...)` — orchestrator: POST conversation + replay, drive the driver, upload the stereo WAV, POST `/analyze`, wait for the server's `evaluation_complete` SSE, return `xray.ReplayResult`. Per-assertion / per-judge failures don't raise — `assert result.passed` is the pytest idiom. Driver-side or server-chain failures raise typed `XrayError` / `ReplayEvaluationError`.

Future SDK module restructure: `xray.init()` + `xray.bind_replay()` + `@xray.observe()` will replace `xray.attach` + `xray.instrument` + `xray.otel`. Tracked separately; not landed in this PR.

## Distribution

Shipped artifact: a Docker image published to **GHCR** (`ghcr.io/xray-eval/xray`) by CI on tagged releases. Operators `docker pull` and run it. No SaaS, no hosted version.

## Local-first

Every CI step must be runnable on a developer machine with one command — image build, image run + smoke test, supply-chain audit, lint, typecheck. CI runs the same scripts; it doesn't have privileged knowledge. If something only works in GitHub Actions, that's a bug.

## Rules

@.claude/rules/honesty.md
@.claude/rules/code-layout.md
@.claude/rules/errors.md
@.claude/rules/pattern-matching.md
@.claude/rules/boundary-validation.md
@.claude/rules/comments.md
@.claude/rules/no-lint-suppressions.md
@.claude/rules/tdd.md
@.claude/rules/supply-chain.md
@.claude/rules/public-repo.md
@.claude/rules/single-image-distribution.md

### Python SDK rules (load when touching `sdk/python/`)

The Python SDK ships with inline types and is gated by `pyright --strict`
in `sdk/python/pyproject.toml` — there's no narrative rule for that
because the config is the rule. The rules below are the parts strict
mode doesn't enforce on its own:

@sdk/python/.claude/rules/no-any.md
@sdk/python/.claude/rules/assert-never.md
@sdk/python/.claude/rules/typed-boundaries.md

## When to write a new rule

A rule under `.claude/rules/` exists to prevent a concrete repeat mistake by future Claude sessions. **All four** of the following must hold before creating one:

1. **Concrete failure mode.** You can name the mistake in one sentence ("Claude runs `npm install` instead of pnpm and trips `only-allow`"). If you can't, it's not a rule.
2. **Not already enforced by code, config, lint, type, test, or CI.** If a `preinstall` guard, an ESLint rule, a `tsconfig` flag, or a CI check already enforces it, *that file is the rule* — don't duplicate it here.
3. **Non-obvious *why*.** Anything obvious from reading the codebase doesn't need a rule. The value is in the reasoning ("7-day cooldown because Shai-Hulud" — not "use pnpm").
4. **Hard constraint, not a preference.** If a reasonable person could disagree on a Tuesday and it'd be fine, it belongs in a CLAUDE.md narrative or a PR description, not in `.claude/rules/`.

When in doubt: don't write the rule. A missing rule is recoverable (the user will correct you); a sprawl of overlapping rules is not.

### Maintenance

- One topic per file. If two rules cover the same topic, merge them.
- Drop a rule once the thing it warns about is enforced by code/CI.
- Cross-link with relative paths; never let contradictory rules accumulate.
