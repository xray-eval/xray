# xray

**xray** — open-source, self-hosted replay/eval framework for LiveKit voice agents. Public repo. React + TypeScript SPA bundled by Bun's built-in HTML bundler (no Vite), Hono on Bun for the API + OTLP receiver, Docker (multi-stage) for distribution. One Bun process serves both the SPA shell (via Bun.serve's HTML routes) and the API. No accounts, no telemetry, no external databases.

**Primary audience.** Python developers writing LiveKit voice agents who want to author conversations as code, run them against their agent, and inspect every turn. The hosted-provider adapters and the legacy custom-loop HTTP ingest are gone — alpha covered the rewrite.

**Voice is the primary investment.** Per-turn audio playback, barge-in indicators, per-stage STT/TTS latency, full-replay mixdown — first-class, not afterthoughts.

**Storage.** Conversations, Replays, recognized OTLP spans, and tool-call / model-usage rows live in a single SQLite file at `/data/xray.db` (mounted volume on the container). Single-writer, embedded, no driver dependency — uses `bun:sqlite`. Why SQLite is the right choice here is the topic of [`.claude/rules/single-image-distribution.md`](./.claude/rules/single-image-distribution.md).

## The two paths data takes into xray

xray has exactly two write surfaces; both are documented and Valibot-validated at the boundary.

1. **Control plane (the SDK calls these directly).**
   - `POST /v1/conversations` — idempotent upsert of the Conversation spec keyed by `(id, version)`. SDK auto-computes `version` as a fingerprint over the turn structure; the server rejects a same-key upsert with a *different* fingerprint as `VersionFingerprintMismatchError`.
   - `POST /v1/replays` — eager Replay-row creation. Returns `replay_id` so the SDK can propagate it (LiveKit room metadata → OTEL baggage) BEFORE the dev's agent emits its first span.
   - `PATCH /v1/replays/:id` — the SDK posts final status + judge result after the runtime completes.

2. **OTLP/HTTP receiver (the dev's agent emits spans).**
   - `POST /v1/otlp/v1/traces` — OpenTelemetry OTLP/JSON traces. **Filters, not gates**: routes spans by the `xray.replay.id` resource attribute and runs each through a vocabulary registry (`src/server/otlp/vocabularies/`: `xray.*`, OTel GenAI semconv `gen_ai.*`, Langfuse). Unknown vocabularies are dropped silently; unknown replay ids are dropped silently. Extracted fields land in `tool_calls`, `model_usage`, `replay_turns`, `assertions`, and raw spans in `spans`.

The two paths are coupled by trust: the OTLP receiver doesn't create Conversation or Replay rows, ever. The trust boundary is the SDK's POST.

## Replay = one execution of one Conversation

There is only one meaning of "replay" in this repo now. The old "agent replay" vs "seed replay" split is gone — `scripts/seed.ts` exercises the same wire as a real run by POSTing a Conversation, then N Replays, then a handful of OTLP batches.

## API documentation

- `GET /openapi.json` — OpenAPI 3.1, auto-assembled from `describeRoute(...)` metadata each router declares.
- `GET /docs` — Scalar UI on top of `/openapi.json`.

The shared `OpenAPIV3.SchemaObject` helper lives in `src/server/core/types.ts` alongside cross-slice error-response schemas — both are wire contracts every router slice depends on.

## SDK

The Python SDK lives at [`sdk/python/`](./sdk/python). Three modules:

- `xray.conversation` — test definitions (`Conversation`, `Turn`, `expect_agent_turn`).
- `xray.trace` — OpenTelemetry decorators (`@stage("stt")` / `@stage("tts")`) + baggage helpers.
- `xray.runtime` — pluggable runtime ABC; `xray.runtime.livekit.LiveKitRuntime` is the v1 implementation. Pipecat / OpenAI Realtime / Gemini Live / raw WebSocket are on the roadmap as new sub-modules.

`xray.run(...)` is the orchestrator that composes all three for the common case.

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
