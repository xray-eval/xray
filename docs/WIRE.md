# Wire contract

This doc describes the OTLP/JSON attribute contract xray expects, the recognized span vocabularies, and the fields each vocabulary extracts.

For the full HTTP API (Conversations, Replays, audio), point your browser at `/docs` on a running xray instance — the OpenAPI 3.1 spec is auto-generated from route metadata.

## OTLP receiver

Endpoint: `POST /v1/otlp/v1/traces`

Content-Type: `application/json` only. Protobuf is rejected with `415` — xray does not ship a protobuf decoder. Configure your OpenTelemetry exporter with:

```
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://xray:8080/v1/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

Limits enforced at the boundary:

| Limit | Value | Response |
|---|---|---|
| Max request body | 4 MiB | `413 body_too_large` |
| Max spans per request | 512 | `400 too_many_spans_per_request` |
| Max *persisted* spans per Replay | 5,000 | `400 too_many_spans_for_replay` (mid-stream) |

The per-replay cap counts persisted spans only — dropped / unrecognized spans don't consume the budget.

## Routing — `xray.replay.id` is the only required attribute

The receiver **filters, not gates**. A span is dropped silently when:

- The span carries no `xray.replay.id` attribute (resource-level or span-level).
- The `xray.replay.id` references a Replay row that does not exist.
- No registered vocabulary claims the span.

Drops are logged at debug level; the OTLP response body reports a `partialSuccess.rejectedSpans` count so the exporter sees them.

A span carrying `xray.replay.id` is routed to that Replay; the SDK's `xray.trace.set_replay_context(...)` puts the value in OTEL baggage so every span the agent emits — `xray.*`, `gen_ai.*`, `langfuse.*` — inherits it without per-call wiring.

## xray resource attributes

| Attribute | Required | Notes |
|---|---|---|
| `xray.replay.id` | Yes (for routing) | UUID returned by `POST /v1/replays`. |
| `xray.conversation.id` | Optional | Convenience; xray already knows from the Replay row. |
| `xray.conversation.version` | Optional | Same as above. |
| `xray.turn.idx` | Per-turn spans | Anchors the span to a `replay_turns.idx`. |
| `xray.turn.key` | Per-turn spans | Cross-replay alignment key for compare views. |
| `xray.modality` | Required | Always `voice` in v1. Reserved for future video/text Replays. |

## Recognized vocabularies

The vocabulary registry is extensible. Adding a vocabulary is a new file under `src/server/otlp/vocabularies/` plus one line in `registry.ts`. Order matters — `xray` runs first, then OTel GenAI semconv, then Langfuse.

### `xray.*` — emitted by xray-py

| Span name | What gets persisted | Notes |
|---|---|---|
| `xray.assertion` | A row in `assertions(replay_id, turn_idx, name, status, message)`. | Attributes: `xray.assertion.name`, `xray.assertion.status` (`passed`/`failed`/`errored`), `xray.assertion.message?`, `xray.turn.idx`. |
| `xray.judge` | Updates `replay_meta.judge_*` on the Replay row. | Attributes: `xray.judge.status`, `xray.judge.score?`, `xray.judge.reason?`, `xray.judge.error?`. |
| `xray.turn` | Upserts a `replay_turns` row. | Attributes: `xray.turn.idx`, `xray.turn.role` (`user`/`agent`), `xray.turn.key?`, `xray.turn.transcript?`, `xray.turn.audio_path?`. |
| `xray.stage.stt` / `xray.stage.tts` | Raw span only — appears under `spans(vocabulary='xray')` in the inspector's span tree. | No extracted row in v1. Surfaces STT/TTS timing per the voice-first investment of the product. |

### `gen_ai.*` — [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

| Span name pattern | What gets persisted | Attributes used |
|---|---|---|
| `chat <model>` / `text_completion <model>` (or `gen_ai.operation.name='chat'`/`'text_completion'`) | A row in `model_usage`. | `gen_ai.system` (provider), `gen_ai.response.model` ∥ `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`. Latency derived from span timestamps. |
| `execute_tool <name>` (or `gen_ai.operation.name='execute_tool'`) | A row in `tool_calls`. | `gen_ai.tool.name`, `gen_ai.tool.arguments?`, `gen_ai.tool.result?`. |
| Any other span with `gen_ai.*` attributes | Raw span only under `spans(vocabulary='gen_ai')`. | — |

### `langfuse.*` — [Langfuse OpenTelemetry trace format](https://langfuse.com/docs/integrations/opentelemetry)

| `langfuse.observation.type` | What gets persisted | Attributes used |
|---|---|---|
| `generation` | A row in `model_usage`. | `langfuse.observation.provider`, `langfuse.observation.model.name`, `langfuse.observation.usage_details.input` / `.output` / `.total`. |
| `tool` | A row in `tool_calls`. | `langfuse.observation.name`, `langfuse.observation.input.value`, `langfuse.observation.output.value`. |
| Anything else (`event`, `span`, `score`, …) | Raw span only under `spans(vocabulary='langfuse')`. | — |

## What's NOT a vocabulary in v1

- `http.*` / `db.*` / generic distributed-tracing semconv — out of scope; the inspector's value is voice-loop introspection, not full APM.
- Proprietary tracing platforms beyond Langfuse — PRs welcome under `src/server/otlp/vocabularies/`.

## Adding a vocabulary

Drop a `src/server/otlp/vocabularies/<your-vocab>.ts` exporting a `SpanVocabularyMatcher`, add it to the array in `registry.ts`, and add to `SPAN_VOCABULARIES` in `src/server/store/types.ts` + the SQL check in `schema.ts`. The OTLP service runs each matcher in registry order and the first non-null wins.
