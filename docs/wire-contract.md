---
layout: default
title: Wire contract (OTLP)
nav_order: 5
---

# OTLP wire contract

xray ingests your agent's OpenTelemetry traces through one endpoint and turns
recognized spans into structured `tool_calls` / `model_usage` rows. This is the
contract: what the endpoint accepts, how a span is routed to a Replay, and
which span shapes are recognized. It's derived from
[`src/server/otlp/`](https://github.com/xray-eval/xray/tree/main/src/server/otlp).

You don't have to emit xray-specific spans. Any agent already instrumented with
the OTel GenAI semantic conventions (`gen_ai.*`) or Langfuse lights up
automatically. The `xray.*` vocabulary is optional and additive.

---

## Endpoint

| | |
|---|---|
| **Path** | `POST /v1/otlp/v1/traces` |
| **Content types** | `application/json` and `application/x-protobuf` (both standard OTLP `ExportTraceServiceRequest`). |
| **Success** | `200` with `{ "partialSuccess": { "rejectedSpans": N } }`. |

`xray.attach`'s exporter posts OTLP/JSON; the stock OTel HTTP exporter's
protobuf default works too. A `Content-Type` with parameters
(`application/json; charset=utf-8`) is matched correctly.

### Limits

| Cap | Value | Behaviour on exceed |
|---|---|---|
| Body size | 4 MiB | `413 body_too_large`. |
| Spans per request | 512 | `400 too_many_spans_per_request` — the whole request is rejected. |
| Spans per replay | 5,000 | Spans over the cap are counted in `rejectedSpans`; in-cap spans in the same batch still persist. No error. |

Other failures map to `400 invalid_otlp_body` (malformed / schema-invalid body),
`415 unsupported_content_type`, or `500 internal_error`.

### Idempotency

Spans are de-duplicated on `(replay_id, span_id)`. Re-sending a span already
stored is a no-op — it isn't re-counted against the cap and its extracted rows
aren't re-processed. Safe to retry a batch.

---

## Routing and the trust boundary

Every span is routed to a Replay by the **`xray.replay.id`** attribute. A
**span-level** value takes precedence; the **resource-level** value is the
fallback. (`attach` sets it as baggage, which the span processor lifts onto
every span, so in practice it's present at the span level.)

The receiver is a **filter, not a gate**. A span is silently dropped (counted
in `rejectedSpans`, never an error) when:

1. it carries no `xray.replay.id` (no replay context — e.g. the agent running
   in production);
2. the `xray.replay.id` names a Replay that doesn't exist; or
3. its vocabulary isn't recognized.

This is the trust boundary: **the OTLP receiver never creates Conversation or
Replay rows.** It only reads existing ones. Replay rows are created exclusively
by the SDK control plane, *before* the agent emits its first span — which is
what makes "unknown replay id → drop" safe rather than lossy.

### Timestamps

`startTimeUnixNano` / `endTimeUnixNano` are converted to ISO-8601 and stored as
each row's `started_at` / `ended_at`. These feed the audio-timeline turn
attribution described below.

---

## The three vocabularies

Each span is run through an ordered registry; the **first** vocabulary that
recognizes it wins. Order is fixed:

1. `xray`
2. `gen_ai` (OTel GenAI semconv)
3. `langfuse`

A vocabulary match can emit a `tool_calls` row, a `model_usage` row, or
neither — but **every** recognized span is also stored raw in the `spans`
table (tagged with the matching vocabulary) for the inspector's timeline.

### 1 · `xray`

Recognizes exactly three span names — an exact-match set, **not** a prefix
wildcard:

- `xray.turn`
- `xray.stage.stt`
- `xray.stage.tts`

These land in the raw `spans` table only; they produce no `tool_calls` /
`model_usage` rows. Turn boundaries come from server-side VAD, and assertion /
judge outcomes come from the declared catalog — not from these spans. Any other
`xray.*` name (e.g. `xray.stage.llm`) is unrecognized and dropped.

> `xray.assertion` and `xray.judge` are **not** recognized. Evaluation runs
> server-side from the `Assertion` / `Judge` catalog declared on the
> Conversation, so driver-emitted assertion/judge spans are intentionally
> ignored.

### 2 · `gen_ai` (OTel GenAI semantic conventions)

Dispatches on **`gen_ai.operation.name`** (a span also counts as GenAI if any
attribute key starts with `gen_ai.`, or its name starts with `chat`,
`text_completion`, or `execute_tool`).

**`execute_tool` → `tool_calls` row:**

| Field | From |
|---|---|
| `name` | `gen_ai.tool.name` (fallback: span name minus the `execute_tool ` prefix) |
| `args_json` | `gen_ai.tool.arguments` |
| `result_json` | `gen_ai.tool.result` |
| `latency_ms` | span `end − start` |

**`chat` or `text_completion` → `model_usage` row:**

| Field | From |
|---|---|
| `provider` | `gen_ai.system` |
| `model` | `gen_ai.response.model` (fallback `gen_ai.request.model`) |
| `input_tokens` / `output_tokens` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` |
| `total_tokens` | sum of the two (null only if both absent) |
| `ttft_ms` | `gen_ai.response.time_to_first_chunk` — interpreted as **seconds**, converted to ms |
| `latency_ms` | span `end − start` |

Any other operation (e.g. `embeddings`) is stored as a raw `gen_ai` span with
no extracted row.

> Earlier docs referred to `gen_ai.tool` and `gen_ai.client.operation`. Those
> are not what the code matches on — the dispatch key is
> `gen_ai.operation.name` with values `execute_tool` / `chat` /
> `text_completion`.

### 3 · `langfuse`

Recognizes any span carrying a `langfuse.`-prefixed attribute. The observation
type is read from `langfuse.observation.type` (fallback `langfuse.type`).

**`generation` → `model_usage` row:**

| Field | From |
|---|---|
| `provider` | `langfuse.observation.provider` |
| `model` | `langfuse.observation.model.name` |
| `input_tokens` / `output_tokens` | `langfuse.observation.usage_details.input` / `.output` |
| `total_tokens` | `langfuse.observation.usage_details.total` (read directly) |
| `ttft_ms` | always `null` (not sourced from Langfuse) |

**`tool` → `tool_calls` row:**

| Field | From |
|---|---|
| `name` | `langfuse.observation.name` (fallback: span name) |
| `args_json` / `result_json` | `langfuse.observation.input.value` / `.output.value` |

Other observation types (`event`, `span`, `score`, unset) are stored as raw
`langfuse` spans with no extracted row.

---

## What lands where

| Table | Written for | When |
|---|---|---|
| `spans` | every accepted span | always, regardless of vocabulary |
| `tool_calls` | gen_ai `execute_tool`, langfuse `tool` | a tool was observed |
| `model_usage` | gen_ai `chat` / `text_completion`, langfuse `generation` | an LLM call was observed |

### Turn attribution is derived, not stored

`tool_calls` and `model_usage` carry only `replay_id` and (nullable) `span_id`
— there is **no `turn_idx` column** on them. A row's turn membership is
computed at evaluation/read time by mapping its wall-clock `started_at` onto the
audio timeline:

```
audio_offset_ms = started_at − replays.recording_started_at
```

and testing it against the turn windows derived from VAD. The
`recording_started_at` origin is set by the driver's audio upload (the
`X-Recording-Started-At` header), never by this OTLP path. With no anchor, the
timeline-dependent assertions (`tool_called`, `tool_not_called`,
`tool_args_match`, `max_ttft_ms`) return `errored`. The origin must be the
audio sample-0 wall-clock (the `X-Recording-Started-At` header), never the
replay row's creation time (which precedes the recording).

---

## Adding a vocabulary

Each vocabulary is one file in
[`src/server/otlp/vocabularies/`](https://github.com/xray-eval/xray/tree/main/src/server/otlp/vocabularies)
exporting a pure `match(span, resource)` function, plus one line in
`registry.ts`. Test it against synthetic projected spans with the slice's
test-utils — no network. See [`architecture.md`](./architecture.md) and the
contributing guide.
