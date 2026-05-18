# xray

![status: alpha](https://img.shields.io/badge/status-alpha-orange)

Open-source replay/eval framework for LiveKit voice agents. One Docker image, one SQLite file, one Python SDK.

> **Alpha.** The wire and SDK API can break between minor versions. **Upgrading from a previous release wipes your data: delete `/data/xray.db` before starting the new container.** Issues and feedback are the most useful contribution right now.

---

## What it does

- **Author a Conversation in Python** — an ordered list of user-side turns, per-turn assertion predicates, and an optional per-replay LLM judge.
- **Run it against your LiveKit voice agent.** The SDK joins your room as a user-side participant, plays the user audio, captures the agent's audio + transcript.
- **xray records the run as a Replay.** The dev's agent emits OpenTelemetry spans during the run — xray's OTLP receiver routes them by `xray.replay.id` and surfaces tool calls, model usage, and timings in the inspector. Spans of recognized vocabularies (`xray.*`, OTel GenAI semconv `gen_ai.*`, Langfuse) light up automatically.
- **Compare runs side-by-side.** Pick 2–8 Replays of one Conversation to grid-compare; pick two Conversations to align by per-turn `key` and see what diverged.

---

## Install

The image is published to GHCR:

```bash
docker pull ghcr.io/xray-eval/xray:0.0.1-alpha
```

Tagged releases are signed with cosign keyless (OIDC). To verify:

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

The Python SDK:

```bash
pip install xray-py[livekit]
```

---

## Quickstart

Drop xray into your existing compose stack alongside your LiveKit agent:

```yaml
# compose.yaml
services:
  xray:
    image: ghcr.io/xray-eval/xray:0.0.1-alpha
    ports:
      - "127.0.0.1:8080:8080"   # bind to localhost only — see Security below
    volumes:
      - xray-data:/data         # SQLite + audio survive container restarts

  my-voice-agent:
    build: .
    environment:
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://xray:8080/v1/otlp/v1/traces
      OTEL_EXPORTER_OTLP_PROTOCOL: http/json
    depends_on:
      - xray

volumes:
  xray-data:
```

`docker compose up`, then open <http://localhost:8080>. The API reference is at <http://localhost:8080/docs>.

### Write a Conversation in Python

```python
from xray import Conversation, Turn, expect_agent_turn, run
from xray.conversation import AgentResponse
from xray.runtime.livekit import LiveKitRuntime
import os

conv = Conversation(
    id="booking-happy-path",
    turns=[
        Turn.user("Hi, I'd like to book a table for two at 7pm.", key="u0"),
        expect_agent_turn(
            key="a0",
            assertion=lambda agent: "confirmed" in agent.transcript.lower(),
            assertion_name="confirms_booking",
        ),
    ],
)

runtime = LiveKitRuntime(
    url=os.environ["LIVEKIT_URL"],
    api_key=os.environ["LIVEKIT_API_KEY"],
    api_secret=os.environ["LIVEKIT_API_SECRET"],
    room="booking-test-room",
)

result = run(
    conversation=conv,
    runtime=runtime,
    xray_url="http://localhost:8080",
    run_config={"model": "gpt-4o", "temperature": 0.5},
)
print(f"replay: http://localhost:8080/replays/{result.id}")
```

### Wire your agent (one-time)

The dev's agent reads `xray.replay.id` (plus `conversation.id` / `version` / `modality`) from LiveKit room metadata and propagates them as OTEL baggage so every span — `xray.*`, `gen_ai.*`, Langfuse — gets routed to the right Replay. See [`docs/SDK.md`](docs/SDK.md).

---

## Compare

- **Replays of the same Conversation:** select 2–8 from the Conversation detail page → grid view with per-column `run_config` headers.
- **Two Conversations:** pick from the Conversations index → side-by-side aligned by per-turn `key`. Unmatched turns render as labeled "no matching turn" placeholders.

---

## Architecture

One Bun process serves both the SPA and the API. One SQLite file at `/data/xray.db` on a mounted volume. No external database, no second container, no managed service. See [`.claude/rules/single-image-distribution.md`](.claude/rules/single-image-distribution.md).

```
   ┌─ xray-py SDK on dev's machine ───────────────────────────────────────┐
   │  POST /v1/conversations   (idempotent upsert by (id, version))     │
   │  POST /v1/replays         → returns replay_id                       │
   │  LiveKitRuntime joins room, plays user audio                        │
   │  PATCH /v1/replays/:id    (final status + judge result)             │
   └─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌─ dev's agent ─────────────────────────────────────────────────────────┐
   │  reads replay.id from room metadata → OTEL baggage                  │
   │  emits xray.* / gen_ai.* / langfuse spans                            │
   └─────────────────────────────────────────────────────────────────────┘
                                  │ OTLP/JSON
                                  ▼
                        ┌────────────────────────┐
                        │  SQLite /data/xray.db  │   single file, mounted volume
                        └────────────────────────┘
                                  │
                                  ▼
                        ┌────────────────────────┐
                        │           UI           │   Conversations · Replays · Compare
                        └────────────────────────┘
```

### Security

- **The SDK→xray surface has no auth.** xray and your agent are expected to live in the same Docker network. **Do not expose port 8080 publicly.** The default compose snippet above binds to `127.0.0.1`.
- Secrets (LiveKit, LLM provider keys) live in the SDK's process, never in xray's. xray's image never holds provider credentials.
- Secrets are runtime-only — pass them at run time (compose `environment:` / `env_file:`, or `docker run -e`), never baked into the image.
- 7-day cooldown on npm releases, deny-by-default lifecycle scripts, every GitHub Action pinned to a 40-char SHA. See [`.claude/rules/supply-chain.md`](.claude/rules/supply-chain.md).
- Releases are signed with cosign keyless (OIDC) and carry build-provenance attestations.

---

## Documentation

- [`docs/SDK.md`](docs/SDK.md) — Python authoring + runtime + how to propagate baggage from LiveKit room metadata.
- [`docs/WIRE.md`](docs/WIRE.md) — OTLP attribute contract + recognized vocabularies and what fields are extracted from each.
- `/docs` on your running instance — generated OpenAPI 3.1 reference rendered by Scalar.

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
