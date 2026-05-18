# xray

![status: alpha](https://img.shields.io/badge/status-alpha-orange)

A self-hosted, single-session debugger for voice agents. One Docker image, SQLite on a mounted volume.

![xray replay diff — source session and replay rendered side by side, turn by turn](docs/assets/hero.png)

**Status: alpha.** Pre-v1. The HTTP ingest wire format and the realtime-replay WebSocket protocol may change before v1. Issues and feedback are the most useful contribution right now.

---

## What it does

xray records voice-agent sessions, renders the transcript with tool calls inlined and per-turn audio playback, and lets you replay a recorded session through an updated version of your agent over a webhook — text or WebSocket. Replays write a fresh session so the source and the replay can be diffed turn by turn.

There are two ways to get sessions into xray: an HTTP ingest endpoint your loop POSTs events to, or a provider adapter that polls a hosted agent platform. One ElevenLabs Convai adapter ships today.

---

## Install

The image is published to GHCR:

```bash
docker pull ghcr.io/xray-eval/xray:0.0.1-alpha
```

Tagged releases are signed with cosign keyless (OIDC). If you want to verify:

```bash
cosign verify ghcr.io/xray-eval/xray:<tag> \
  --certificate-identity-regexp 'https://github.com/xray-eval/xray/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Or build from source:

```bash
git clone https://github.com/xray-eval/xray.git
cd xray
docker build -t xray:local .
```

---

## Quickstart

xray is designed to sit in the same Docker network as your voice agent so your loop can POST events to it over the internal DNS name. Drop xray into your existing compose stack:

```yaml
# compose.yaml
services:
  xray:
    image: ghcr.io/xray-eval/xray:0.0.1-alpha
    ports:
      - "8080:8080"          # only expose if you want the UI reachable from the host
    volumes:
      - xray-data:/data      # SQLite + audio files survive container restarts

  my-voice-agent:
    build: .
    environment:
      XRAY_URL: http://xray:8080
    depends_on:
      - xray

volumes:
  xray-data:
```

`docker compose up`, then open <http://localhost:8080>. The API reference is at <http://localhost:8080/docs>.

### From your voice loop — four `fetch` calls

Any language with an HTTP client works. Stream events as they happen; the UI updates as new turns arrive.

```js
const XRAY = process.env.XRAY_URL;

// 1. Session starts
await fetch(`${XRAY}/v1/sessions/sess-42/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "session_started",
    agentId: "concierge",
    startedAt: new Date().toISOString(),
  }),
});

// 2. A user turn completes
await fetch(`${XRAY}/v1/sessions/sess-42/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "turn_completed",
    idx: 0,
    role: "user",
    text: "Book me a table for two at the bistro tonight at seven.",
    timestamp: new Date().toISOString(),
  }),
});

// 3. An agent turn completes — include the latency-to-first-output
await fetch(`${XRAY}/v1/sessions/sess-42/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "turn_completed",
    idx: 1,
    role: "agent",
    text: "Got it — two people, seven PM. Checking availability now.",
    timestamp: new Date().toISOString(),
    responseLatencyMs: 720,
  }),
});

// 4. Session ends
await fetch(`${XRAY}/v1/sessions/sess-42/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "session_ended",
    endedAt: new Date().toISOString(),
    durationMs: 22_000,
  }),
});
```

See [`docs/INGEST.md`](docs/INGEST.md) for the full wire contract — tool calls, barge-in, voice-to-voice events, and per-turn audio upload.

---

## Replay

From any recorded session, you can re-run the user-side inputs through your updated agent code and render the result next to the original.

1. Click **Replay** on a recorded session and paste a webhook URL.
2. xray POSTs each user turn (text + recorded tool results) to your webhook.
3. Your webhook returns the new agent text (and optionally tool calls + latency).
4. xray writes a fresh session and renders it next to the original.

Two flavors, both documented at `/docs` on your running instance:

- **Text replay** (`POST /v1/replays`) — your webhook is an HTTP endpoint.
- **Realtime / V2V replay** (`POST /v1/replays/realtime`) — your webhook is a WebSocket server. xray streams the recorded user audio chunk-by-chunk and consumes your agent's audio + transcript frames. Frame protocol is at `/asyncapi.json`.

Recorded tool results are forwarded so the replay doesn't re-execute real side effects.

---

## Adapter mode

If you use ElevenLabs Convai, you can skip the ingest step entirely. Set `ELEVENLABS_API_KEY` and xray pulls conversations from ElevenLabs' API into the same SQLite store the UI reads from:

```yaml
services:
  xray:
    image: ghcr.io/xray-eval/xray:0.0.1-alpha
    ports:
      - "8080:8080"
    volumes:
      - xray-data:/data
    environment:
      ELEVENLABS_API_KEY: ${ELEVENLABS_API_KEY}
```

ElevenLabs is the only adapter today. New adapters live under [`src/adapters/<provider>/`](src/adapters/) — PRs welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Architecture

One Bun process serves both the SPA shell and the API. One SQLite file at `/data/xray.db` on a mounted volume. No external database, no second container, no managed service required. See [`.claude/rules/single-image-distribution.md`](.claude/rules/single-image-distribution.md) for why SQLite is the right fit here.

```
                ┌─ src/adapters/<provider>/   (REST poll: ElevenLabs Convai)
   sources  ────┤
                └─ POST /v1/sessions/:id/events   (HTTP ingest)
                         │
                         ▼
                ┌────────────────────────┐
                │  SQLite  /data/xray.db │   single file, mounted volume, `bun:sqlite`
                └────────────────────────┘
                         │
                         ▼
                ┌────────────────────────┐
                │           UI           │   list • transcript • inspector • replay
                └────────────────────────┘
```

### Security

- Secrets are runtime-only — API keys are passed at run time (compose `environment:` / `env_file:`, or `docker run -e`), never baked into the image.
- 7-day cooldown on npm releases, deny-by-default lifecycle scripts, every GitHub Action pinned to a 40-char commit SHA. See [`.claude/rules/supply-chain.md`](.claude/rules/supply-chain.md).
- Releases are signed with cosign keyless (OIDC) and carry build-provenance attestations.

---

## Development

```bash
corepack enable             # picks up the pinned pnpm
pnpm install                # frozen-lockfile-safe; respects 7-day cooldown
pnpm dev                    # single Bun process via compose.dev.yaml (HMR for SPA + API)
pnpm docker:smoke           # build image, run it, curl /healthz, kill — same check CI runs
```

Every CI step runs locally with one pnpm script. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

---

## License

[Elastic License 2.0](LICENSE). Free to use, copy, modify, and self-host, including commercially inside your own organization. You may not offer xray to third parties as a hosted or managed service.
