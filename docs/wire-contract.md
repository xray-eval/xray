---
title: Wire contract (OTLP)
---

# OTLP wire contract

First, some vocabulary. OpenTelemetry (OTel) is a standard for emitting
traces from running software. OTLP is the wire protocol OTel uses to ship
those traces over the network. A trace is made of **spans**. A span is one
timed unit of work (a tool call, an LLM request). Each span carries
**attributes**, which are key/value pairs that describe it.

xray ingests your agent's OpenTelemetry traces through one endpoint. It turns
recognized spans into structured `tool_calls` / `model_usage` rows. This page
is the contract. It covers three things:

- what the endpoint accepts,
- how a span is routed to a Replay, and
- which span shapes are recognized.

It's derived from
[`src/server/otlp/`](https://github.com/xray-eval/xray/tree/main/src/server/otlp).

You don't have to emit xray-specific spans. Maybe your agent is already
instrumented with the OTel GenAI semantic conventions (`gen_ai.*`) or with
Langfuse. If so, it lights up automatically. The `xray.*` vocabulary is
optional and additive.

---

## Endpoint

| | |
|---|---|
| **Path** | `POST /v1/otlp/v1/traces` |
| **Content types** | `application/json` and `application/x-protobuf` (both standard OTLP `ExportTraceServiceRequest`). |
| **Success** | `200` with `{ "partialSuccess": { "rejectedSpans": N } }`. |

`xray.attach`'s exporter posts OTLP/JSON. The stock OTel HTTP exporter defaults
to protobuf, and that works too. A `Content-Type` with parameters
(`application/json; charset=utf-8`) is matched correctly.

### Limits

| Cap | Value | Behaviour on exceed |
|---|---|---|
| Body size | 4 MiB | `413 body_too_large`. |
| Spans per request | 512 | `400 too_many_spans_per_request`. The whole request is rejected. |
| Spans per replay | 5,000 | Spans over the cap are counted in `rejectedSpans`; in-cap spans in the same batch still persist. No error. |

Other failures map to one of these:

- `400 invalid_otlp_body` (malformed or schema-invalid body),
- `415 unsupported_content_type`, or
- `500 internal_error`.

### Idempotency

Spans are de-duplicated on `(replay_id, span_id)`. Re-sending a span that is
already stored is a no-op. It isn't re-counted against the cap. Its extracted
rows aren't re-processed. So a batch is safe to retry.

---

## Routing and the trust boundary

Every span is routed to a Replay by the **`xray.replay.id`** attribute. The
value can sit in two places. A **span-level** value takes precedence. The
**resource-level** value is the fallback. (`attach` sets it as baggage. The span
processor lifts that baggage onto every span. So in practice the value is
present at the span level.)

The receiver is a **filter, not a gate**. A span is silently dropped (counted
in `rejectedSpans`, never an error) in three cases:

1. it carries no `xray.replay.id` (no replay context, for example the agent
   running in production);
2. the `xray.replay.id` names a Replay that doesn't exist; or
3. its vocabulary isn't recognized.

This is the trust boundary: **the OTLP receiver never creates Conversation or
Replay rows.** It only reads existing ones. Replay rows are created exclusively
by the SDK control plane. That happens *before* the agent emits its first span.
That ordering is what makes "unknown replay id, so drop" safe rather than
lossy.

### Timestamps

`startTimeUnixNano` / `endTimeUnixNano` are converted to ISO-8601. They are
stored as each row's `started_at` / `ended_at`. These feed the audio-timeline
turn attribution described below.

---

## The three vocabularies

A **vocabulary** is a set of rules for recognizing one family of spans. Each
span is run through an ordered registry of vocabularies. The **first** one that
recognizes the span wins. The order is fixed:

1. `xray`
2. `gen_ai` (OTel GenAI semconv)
3. `langfuse`

A vocabulary match can emit a `tool_calls` row, a `model_usage` row, or
neither. But **every** recognized span is also stored raw in the `spans`
table, tagged with the matching vocabulary, for the inspector's timeline.

### 1 · `xray`

This vocabulary recognizes exactly three span names. It is an exact-match set,
**not** a prefix wildcard:

- `xray.turn`
- `xray.stage.stt`
- `xray.stage.tts`

These land in the raw `spans` table only. They produce no `tool_calls` /
`model_usage` rows. Turn boundaries come from server-side VAD. Assertion and
judge outcomes come from the declared catalog, not from these spans. Any other
`xray.*` name (for example `xray.stage.llm`) is unrecognized and dropped.

> `xray.assertion` and `xray.judge` are **not** recognized. Evaluation runs
> server-side from the `Assertion` / `Judge` catalog declared on the
> Conversation. So driver-emitted assertion/judge spans are intentionally
> ignored.

### 2 · `gen_ai` (OTel GenAI semantic conventions)

This vocabulary dispatches on the **`gen_ai.operation.name`** attribute. A span
also counts as GenAI if any of these is true: an attribute key starts with
`gen_ai.`, or the span name starts with `chat`, `text_completion`, or
`execute_tool`.

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
| `ttft_ms` | `gen_ai.response.time_to_first_chunk`, interpreted as **seconds**, converted to ms |
| `latency_ms` | span `end − start` |

Any other operation (for example `embeddings`) is stored as a raw `gen_ai` span
with no extracted row.

> Earlier docs referred to `gen_ai.tool` and `gen_ai.client.operation`. Those
> are not what the code matches on. The dispatch key is
> `gen_ai.operation.name`, with values `execute_tool` / `chat` /
> `text_completion`.

### 3 · `langfuse`

This vocabulary recognizes any span carrying an attribute with a `langfuse.`
prefix. It reads the observation type from `langfuse.observation.type`
(fallback `langfuse.type`).

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

`tool_calls` and `model_usage` carry only `replay_id` and (nullable) `span_id`.
There is **no `turn_idx` column** on them. A row's turn membership is not
stored. It is computed at evaluation/read time. The server maps the row's
wall-clock `started_at` onto the audio timeline:

```
audio_offset_ms = started_at − replays.recording_started_at
```

It then tests that offset against the turn windows derived from VAD. The
`recording_started_at` origin is set by the driver's audio upload (the
`X-Recording-Started-At` header). This OTLP path never sets it. With no anchor,
the timeline-dependent assertions return `errored`. Those assertions are
`tool_called`, `tool_not_called`, `tool_args_match`, and `max_ttft_ms`. The
origin must be the audio sample-0 wall-clock (the `X-Recording-Started-At`
header). It must never be the replay row's creation time, which precedes the
recording.

---

## Adding a vocabulary

Each vocabulary is one file in
[`src/server/otlp/vocabularies/`](https://github.com/xray-eval/xray/tree/main/src/server/otlp/vocabularies).
The file exports a pure `match(span, resource)` function. You also add one line
in `registry.ts`. Test it against synthetic projected spans with the slice's
test-utils. No network is needed. See [`architecture.md`](./architecture.md) and
the contributing guide.
