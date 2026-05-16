# Ingest — voice-agent event wire format

xray observes two paradigms of voice agents. The same `POST /v1/sessions/:id/events` endpoint covers both — pick the field set that matches how your loop is built. Schemas live in [`src/server/ingest/ingest.types.ts`](../src/server/ingest/ingest.types.ts).

The session id lives in the URL only; retries are idempotent on the URL alone. All timestamps are ISO 8601; xray normalizes to UTC `Z` at the boundary.

## Voice-to-voice (OpenAI Realtime, Gemini Live, Claude voice-to-voice)

One model handles audio in → audio out. There is no separable LLM stage, and barge-in is a first-class wire event.

```jsonc
// One round-trip: user speaks, model responds, user cuts the model off mid-sentence.
// Map provider events into xray's wire schema as follows.

// Provider: OpenAI → `conversation.item.input_audio_transcription.completed`
//           Gemini   → `BidiGenerateContentServerContent.inputTranscription`
POST /v1/sessions/sess-42/events
{ "type": "turn_completed", "idx": 0, "role": "user",
  "text": "What's the weather in Paris today?",
  "timestamp": "2026-05-16T12:00:01.000Z" }

// Provider: OpenAI → `response.audio_transcript.done`
//           Gemini   → `BidiGenerateContentServerContent.outputTranscription`
// responseLatencyMs = end-of-user-speech → first model audio chunk.
// interrupted: the user barged in 800ms into the model's playback;
//   OpenAI: client sent `response.cancel` + `conversation.item.truncate`.
//   Gemini: server emits `serverContent.interrupted: true`.
POST /v1/sessions/sess-42/events
{ "type": "turn_completed", "idx": 1, "role": "agent",
  "text": "It's 18°C and sunny in Paris—",
  "timestamp": "2026-05-16T12:00:02.400Z",
  "responseLatencyMs": 400,
  "interrupted": true,
  "interruptedAtMs": 800 }
```

Tool calls map to a separate event under the agent turn that initiated them:

```jsonc
// Provider: OpenAI → `response.function_call_arguments.done`
//           Gemini   → `BidiGenerateContentToolCall`
POST /v1/sessions/sess-42/events
{ "type": "tool_called", "turnIdx": 1, "idx": 0,
  "name": "get_weather", "args": { "city": "Paris" },
  "result": { "tempC": 18, "conditions": "sunny" },
  "latencyMs": 120 }
```

## STT→LLM→TTS pipeline (Pipecat, LiveKit Agents, raw stacks)

Three discrete stages. `responseLatencyMs` records the LLM stage time — the response cycle xray is built to debug. If you want per-stage STT/TTS latencies, log them to your own observability stack; xray's surface is the response, not the pipeline internals.

```jsonc
POST /v1/sessions/sess-42/events
{ "type": "turn_completed", "idx": 0, "role": "user",
  "text": "What's the weather in Paris today?",
  "timestamp": "2026-05-16T12:00:01.000Z" }

POST /v1/sessions/sess-42/events
{ "type": "turn_completed", "idx": 1, "role": "agent",
  "text": "It's 18°C and sunny in Paris.",
  "timestamp": "2026-05-16T12:00:02.300Z",
  "responseLatencyMs": 300 }
```

Pipelines rarely emit barge-in as a wire event — the dev's code handles it. If yours does surface it, the same `interrupted` / `interruptedAtMs` fields apply.

## Bookending a session

`session_started` and `session_ended` are optional — xray auto-creates a stub session on the first `turn_completed` and accepts a later `session_started` as a metadata upsert. Send them when you have the data:

```jsonc
POST /v1/sessions/sess-42/events
{ "type": "session_started", "agentId": "weather-bot",
  "startedAt": "2026-05-16T12:00:00.000Z" }

POST /v1/sessions/sess-42/events
{ "type": "session_ended", "endedAt": "2026-05-16T12:00:03.500Z",
  "durationMs": 3500 }
```

Every event is idempotent on its identity key (`session_id` for sessions, `(session_id, idx)` for turns, `(turn_id, idx)` for tool calls). Re-POSTing the same event is a no-op — safe to retry on network failures.
