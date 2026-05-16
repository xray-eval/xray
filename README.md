# Voice Agent X-Ray

> Voice agents are exploding. Debugging them is broken. **Voice Agent X-Ray**: drop in a conversation, see exactly what your agent did and why.

<!-- TODO: 30-second Loom embed goes here, above the fold. Live conversation, graph lights up, click a turn, inspector reveals everything. -->

One screen. Workflow graph + transcript + inspector. Click a transcript turn → the node lights up, the inspector shows the prompt the LLM saw, the tool calls, the edge that fired, and *why*.

## Why this exists

The same shape of debugging pain — invisible reasoning, fragmented surfaces, no live trace — exists across every voice-agent platform. The clearest documented version is on ElevenLabs Agent Workflows: you jump between four dashboard tabs (Workflow, Call history, Tool executions, Conversation analysis) to figure out a single failure, and the graph stays static while you talk to it. X-Ray collapses that to one screen, lights up the path actually taken, and exposes the LLM's branch reasoning.

## Sources

X-Ray ingests conversations through two coexisting paths. Pick the one that matches how your voice agent is built — or use both side-by-side against the same UI.

### Custom voice loops — via HTTP ingest

| Status | How it works                                                                                                                                                                                                                                |
|--------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `v1`   | Your loop POSTs events to `POST /v1/sessions/:id/events` as they happen. Covers end-to-end voice-to-voice models (OpenAI Realtime, Gemini Live) and STT→LLM→TTS pipelines alike. Language-agnostic; no SDK required, just an HTTP client.   |

You own the loop; xray observes it. No workflow graph (your routing lives in your code), but you get transcript, tool calls, latencies, and the "what did the LLM actually see" inspector.

### Provider-hosted agents — via adapter

| Provider     | Status       |
|--------------|--------------|
| ElevenLabs   | planned (v1) |
| Vapi         | open         |
| Retell       | open         |
| Voiceflow    | open         |

For platforms that host the agent definition and run orchestration themselves. Each provider is one file in [`src/adapters/`](./src/adapters/) implementing the [`VoiceAgentAdapter`](./src/adapters/types.ts) interface — adapter reads agents, workflow graph, and past conversations from the provider's API. PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

Voice-to-voice model APIs (OpenAI Realtime, Gemini Live) don't fit the adapter shape — there's no hosted agent entity to query, just a model. They go through the ingest path above.

## Architecture

```
                ┌─ src/adapters/<provider>/   (REST poll: ElevenLabs, etc.)
   sources  ────┤
                └─ POST /v1/sessions/:id/events   (HTTP ingest: custom loops)
                         │
                         ▼
                ┌────────────────────────┐
                │  SQLite  /data/xray.db │   single file, mounted volume, `bun:sqlite`
                └────────────────────────┘
                         │
                         ▼
                ┌────────────────────────┐
                │   one source-agnostic  │   workflow graph + transcript + inspector
                │           UI           │
                └────────────────────────┘
```

One Bun process owns the writer. One SQLite file holds the data. One UI reads through the same process. The distribution model — single Docker image, one mounted volume — is load-bearing; see [`.claude/rules/single-image-distribution.md`](./.claude/rules/single-image-distribution.md).

## Quick start

X-Ray is **self-hosted** and ships as a single Docker image on GHCR. You bring the provider API key; it never touches the browser. The `-v xray-data:/data` flag mounts the SQLite store so conversations survive container restarts.

```bash
docker run --rm \
  -p 8080:8080 \
  -v xray-data:/data \
  -e ELEVENLABS_API_KEY=sk_... \
  ghcr.io/<owner>/xray:latest
```

Then open <http://localhost:8080>.

### Bring your own voice-agent loop

If you're running a custom STT→LLM→TTS loop (OpenAI Realtime, Gemini Live, an in-house stack), point it at the ingest endpoint — no SDK required. Same shape from any language with an HTTP client:

```bash
curl -X POST http://localhost:8080/v1/sessions/abc123/events \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "user_transcript",
    "ts": 1715865600000,
    "text": "Book me a flight to Berlin."
  }'
```

Stream events as they happen; the UI updates live. Event schema and the full event list are documented in the ingest route — see [`src/server/ingest/`](./src/server/ingest/) once that ticket lands.

`compose.yaml` in this repo is a working production example. Drop it into your existing stack behind your own reverse proxy.

## Stack

Vite + React + TypeScript SPA · [React Flow](https://reactflow.dev) for the node graph · Tailwind + shadcn/ui · [Hono](https://hono.dev) on [Bun](https://bun.sh) for the proxy backend · SQLite via `bun:sqlite` for the conversation store · Docker (multi-stage) for distribution.

The Hono proxy is the only thing that ever sees the API key. SQLite is a single file at `/data/xray.db` on a mounted volume. No external databases, no accounts, no telemetry.

## Security stance

This is the security story:

- **Open source = audit surface.** The proxy is small enough to read in one sitting. That's what justifies handing it credentials that could drain a provider account.
- **Secrets are runtime-only.** API keys enter via `docker run -e` or `--env-file`. They are *never* baked into the image. See [`.claude/rules/public-repo.md`](./.claude/rules/public-repo.md) §2.
- **Supply chain is paranoid by default.** 7-day cooldown on npm releases, deny-by-default lifecycle scripts, every GitHub Action pinned to a 40-char commit SHA. See [`.claude/rules/supply-chain.md`](./.claude/rules/supply-chain.md).
- **Releases are signed.** GHCR images are built by GitHub Actions with cosign keyless signing (OIDC) and `actions/attest-build-provenance` attestation. Verify with `cosign verify ghcr.io/<owner>/xray:<tag> --certificate-identity=...`.

## Development

```bash
corepack enable             # picks up the pinned pnpm
pnpm install                # frozen-lockfile-safe; respects 7-day cooldown
pnpm dev                    # Vite + Hono via compose.dev.yaml (HMR on both sides)
pnpm docker:smoke           # build image, run it, curl /healthz, kill — same check CI runs
```

Every CI step runs locally with one pnpm script — if something only works in GitHub Actions, that's a bug. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full loop.

## License

[Elastic License 2.0](./LICENSE). Free to use, copy, modify, and self-host — including for commercial use inside your own organization. The one thing you may **not** do is offer X-Ray to third parties as a hosted or managed service ("X-Ray-as-a-SaaS"). Contributions back to this repo are welcome and remain under the same license.

If you have a use case that doesn't fit those limits, open an issue and we'll talk.
