# xray

**xray** — open-source, self-hosted single-session debugger for voice agents. Public repo. React + TypeScript SPA bundled by Bun's built-in HTML bundler (no Vite), Hono on Bun for the API + proxy, Docker (multi-stage) for distribution. One Bun process serves both the SPA shell (via Bun.serve's HTML routes) and the API. No accounts, no telemetry, no external databases.

**Primary audience.** Custom voice-loop developers — Pipecat, LiveKit Agents, OpenAI Realtime, Gemini Live, raw STT→LLM→TTS, anything homegrown. The differentiator for that audience is **agent replay**: take a recorded session, re-run its user-side inputs through the dev's updated agent code via a webhook, render source vs replay side-by-side. Hosted-provider adapters (ElevenLabs Convai, Vapi, etc.) are a secondary path, not the lead.

**Voice is the primary investment.** The wire contract is text-shaped (so a dev can iterate on the LLM-decision part of their loop without re-running audio), but voice-specific surfaces — per-turn audio playback, barge-in indicators, per-stage latency, V2V replay over a WebSocket — are first-class, not afterthoughts. Text-only agents work; they aren't who we're optimizing for.

**Storage.** Conversations live in a single SQLite file at `/data/xray.db` (mounted volume on the container). Single-writer, embedded, no driver dependency — uses `bun:sqlite`. Why SQLite is the right choice here is the topic of [`.claude/rules/single-image-distribution.md`](./.claude/rules/single-image-distribution.md).

**Two sources, one store.** Conversations enter the store through two coexisting paths:

1. **HTTP ingest** (`POST /v1/sessions/:id/events`) — custom voice-agent loops (raw STT→LLM→TTS, OpenAI Realtime, Gemini Live, in-house stacks) push events directly. Language-agnostic wire contract; no SDK required. **Primary path.**
2. **Provider adapters** (REST poll) — `src/adapters/<provider>/` reads from a hosted agent platform (e.g. ElevenLabs Convai) and writes into the store. **Secondary path.**

Both write into the same SQLite store. One source-agnostic UI reads from it. The dual-source design is deliberate: ingest covers the dominant audience (no provider lock-in); adapters cover the long tail of devs using hosted providers (no instrumentation needed).

**Two meanings of "replay" in this repo.** Don't conflate them:
- **Agent replay** = the user-facing debugger feature. `POST /v1/replays` (text) and `POST /v1/replays/realtime` (WebSocket V2V). Re-runs a session through the dev's webhook. **The differentiator.**
- **Seed / event replay** = the internal dev affordance. `scripts/seed.ts` POSTs curated `data/fixtures/*.jsonl` sessions through the ingest endpoint so the UI is exercisable without a microphone, an API key, or a voice-model bill. Same files power tests and demo material.

**API documentation.** Three contract surfaces, generated from the existing Valibot schemas in `src/server/*/*.types.ts`:
- `GET /openapi.json` — OpenAPI 3.1 for the HTTP routes + text-replay webhook.
- `GET /asyncapi.json` — AsyncAPI 3.0 for the realtime-replay WebSocket frame protocol.
- `GET /docs` — Scalar UI rendering the OpenAPI spec, with a link to the AsyncAPI doc.

The shared `OpenAPIV3.SchemaObject` helper lives in `src/server/core/types.ts` alongside cross-slice error-response schemas — both are wire contracts every router slice depends on. The docs assembler in `src/server/docs/` reads route metadata at request time, so adding a `describeRoute(...)` to a new router auto-populates the spec.

**Distribution.** The shipped artifact is a Docker image published to **GHCR** (`ghcr.io/basilebong/xray`) by CI on tagged releases. Operators `docker pull` and run it. No SaaS, no hosted version.

**Local-first.** Every CI step must be runnable on a developer machine with one command — image build, image run + smoke test, supply-chain audit, lint, typecheck. CI runs the same scripts; it doesn't have privileged knowledge. If something only works in GitHub Actions, that's a bug.

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
