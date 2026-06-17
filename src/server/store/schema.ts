import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type {
	AnalysisStep,
	ReplayFailureReason,
	ReplayLifecycleState,
	SpanVocabulary,
	TurnRole,
} from "./types.ts";

// Conventions (kept consistent across the codebase):
// - Primary keys are `text` UUIDs unless the table is a child collection keyed
//   by a parent + ordinal (e.g. `replay_turns`).
// - Timestamps are UTC ISO 8601 stored as `text`; offsets within an audio
//   recording are `integer` milliseconds from the recording's `t=0`.
// - JSON payloads stay as JSON-encoded `text` columns; deserialization is the
//   reader's job.

// Conversations — dev-authored test definitions
//
// Primary key is `hash`: a 64-char hex SHA-256 over the canonical-JSON
// encoding of the turns (including sha256 of per-turn RecordedAudio bytes).
// The dev sets `name` as a free-form display label; renaming does NOT change
// identity, so a re-POST with the same hash and a different name updates the
// existing row's `name` (last-write-wins). `last_run_at` is set to `now` on
// every POST /v1/conversations — the SDK calls that endpoint at the start
// of every run, so the timestamp tracks "most recent attempt" without a
// join back to replays.
//
// (Older comments here described `last_run_at` as denormalized from
// `MAX(replays.started_at)`; that was the design but never the
// implementation — see `conversations.service.ts`.)
export const conversations = sqliteTable(
	"conversations",
	{
		hash: text("hash").primaryKey(),
		name: text("name").notNull(),
		// JSON-encoded array of turn descriptors. Schema validated at the wire
		// boundary; storage is opaque to the DB.
		turnsJson: text("turns_json").notNull(),
		createdAt: text("created_at").notNull(),
		lastRunAt: text("last_run_at"),
	},
	(t) => [
		check("conversations_hash_ck", sql`length(${t.hash}) = 64`),
		index("idx_conversations_last_run_at").on(t.lastRunAt),
	],
);

// TTS synthesis cache — maps the deterministic config fingerprint
// (sha256 over {provider, model, voice, text}) to the sha256 of the
// generated 48kHz mono WAV stored at `<audioRoot>/tts/<audio_sha256>.wav`.
//
// Why this table exists: the conversation hash folds in the *output*
// audio sha256 (generated audio is part of the test identity, like
// recorded audio), but TTS output is non-deterministic — the same text
// re-synthesized yields different bytes. Without this index, every
// re-POST of an unchanged spec would re-synthesize, produce new bytes,
// and fork the conversation onto a new hash. The fingerprint lookup makes
// the upsert deterministic: same spec + same TTS config → same cached
// audio sha → same conversation hash.
export const ttsSynthCache = sqliteTable(
	"tts_synth_cache",
	{
		fingerprint: text("fingerprint").primaryKey(),
		audioSha256: text("audio_sha256").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		voice: text("voice").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		check("tts_synth_cache_fingerprint_ck", sql`length(${t.fingerprint}) = 64`),
		check("tts_synth_cache_audio_sha256_ck", sql`length(${t.audioSha256}) = 64`),
	],
);

// Replays — one execution of one Conversation.
//
// Lifecycle is server-owned: the driver POSTs to create (`pending`), PATCHes
// the row to `running` while it executes, the server flips to
// `recording_uploaded` on POST /audio and to `analyzing` on POST /analyze.
// The bunqueue worker transitions to `completed` or `failed` when the job
// terminates.
export const replays = sqliteTable(
	"replays",
	{
		id: text("id").primaryKey(),
		conversationHash: text("conversation_hash")
			.notNull()
			.references(() => conversations.hash, { onDelete: "restrict" }),
		lifecycleState: text("lifecycle_state").$type<ReplayLifecycleState>().notNull(),
		// Current analysis sub-step, surfaced over SSE. Null outside `analyzing`.
		analysisStep: text("analysis_step").$type<AnalysisStep | null>(),
		failureReason: text("failure_reason").$type<ReplayFailureReason | null>(),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
		// Wall-clock (UTC ISO-8601) of audio sample 0 — the driver's
		// `min(segment.started_at)`, sent via the `X-Recording-Started-At`
		// header on POST /audio. This is the SOLE origin for mapping a span's
		// wall-clock `started_at` onto the audio timeline
		// (`audio_offset_ms = started_at − recording_started_at`). Null when an
		// older SDK omits the header: offsets are then undefined and span→turn
		// attribution is skipped rather than mis-anchored to `started_at`
		// (which is row-creation time, not recording start — see spec 0001).
		recordingStartedAt: text("recording_started_at"),
		// Path under XRAY_AUDIO_ROOT to the uploaded stereo WAV.
		audioPath: text("audio_path"),
		// Opaque dev-side snapshot of the SUT config at run start.
		runConfigJson: text("run_config_json"),
		// bunqueue job id assigned when /analyze is invoked. Null until then.
		jobId: text("job_id"),
	},
	(t) => [
		index("idx_replays_conversation_hash").on(t.conversationHash, t.startedAt),
		index("idx_replays_started_at").on(t.startedAt),
		check(
			"replays_lifecycle_state_ck",
			sql`${t.lifecycleState} IN ('pending', 'running', 'recording_uploaded', 'analyzing', 'completed', 'failed')`,
		),
		check(
			"replays_analysis_step_ck",
			sql`${t.analysisStep} IS NULL OR ${t.analysisStep} IN ('vad', 'transcribe', 'metrics', 'evaluate')`,
		),
		check(
			"replays_failure_reason_ck",
			sql`${t.failureReason} IS NULL OR ${t.failureReason} IN ('stalled', 'timeout', 'explicit_fail', 'max_attempts_exceeded', 'worker_lost', 'upload_failed', 'driver_aborted', 'agent_not_joined', 'audio_missing', 'missing_credential', 'transcription_failed', 'metrics_failed', 'evaluation_failed', 'spec_vad_mismatch')`,
		),
	],
);

// Speech segments — VAD output, one row per detected voiced chunk per channel.
export const speechSegments = sqliteTable(
	"speech_segments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		channel: text("channel").$type<TurnRole>().notNull(),
		startMs: integer("start_ms").notNull(),
		endMs: integer("end_ms").notNull(),
	},
	(t) => [
		index("idx_speech_segments_replay_start").on(t.replayId, t.startMs),
		check("speech_segments_channel_ck", sql`${t.channel} IN ('user', 'agent')`),
	],
);

// Replay turns — derived from speech_segments.
//
// `turn_start_ms` / `turn_end_ms` are the "turn boundary" — start = directly
// after the other side's last segment ended; end = this side's last segment
// in the turn ended.
// `voice_start_ms` / `voice_end_ms` are the "voice-active boundary" — start =
// this side's first speech in the turn, end = this side's last speech in the
// turn (equals turn_end_ms under the current no-overlap rule, stored
// separately for future overlap handling).
export const replayTurns = sqliteTable(
	"replay_turns",
	{
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		idx: integer("idx").notNull(),
		role: text("role").$type<TurnRole>().notNull(),
		turnStartMs: integer("turn_start_ms").notNull(),
		turnEndMs: integer("turn_end_ms").notNull(),
		voiceStartMs: integer("voice_start_ms").notNull(),
		voiceEndMs: integer("voice_end_ms").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.replayId, t.idx], name: "replay_turns_pk" }),
		check("replay_turns_role_ck", sql`${t.role} IN ('user', 'agent')`),
	],
);

// Spans — recognized OTLP spans persisted under a replay.
export const spans = sqliteTable(
	"spans",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		traceId: text("trace_id").notNull(),
		spanId: text("span_id").notNull(),
		parentSpanId: text("parent_span_id"),
		name: text("name").notNull(),
		vocabulary: text("vocabulary").$type<SpanVocabulary>().notNull(),
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at").notNull(),
		attributesJson: text("attributes_json").notNull(),
	},
	(t) => [
		index("idx_spans_replay_started").on(t.replayId, t.startedAt),
		index("idx_spans_trace").on(t.traceId),
		unique("spans_replay_span_uk").on(t.replayId, t.spanId),
		check("spans_vocabulary_ck", sql`${t.vocabulary} IN ('xray', 'gen_ai', 'langfuse')`),
	],
);

export const toolCalls = sqliteTable(
	"tool_calls",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		spanId: text("span_id"),
		name: text("name").notNull(),
		argsJson: text("args_json"),
		resultJson: text("result_json"),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		latencyMs: integer("latency_ms"),
	},
	(t) => [index("idx_tool_calls_replay").on(t.replayId, t.startedAt)],
);

export const modelUsage = sqliteTable(
	"model_usage",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		spanId: text("span_id"),
		provider: text("provider"),
		model: text("model"),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		totalTokens: integer("total_tokens"),
		// Model time-to-first-token (ms), from the GenAI semconv span attribute
		// `gen_ai.response.time_to_first_chunk` (seconds → ms). Optional, exactly
		// like the token counts: null when the agent's instrumentation doesn't
		// emit it. A same-clock delta, so it needs no audio-timeline correlation.
		ttftMs: integer("ttft_ms"),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		latencyMs: integer("latency_ms"),
	},
	(t) => [index("idx_model_usage_replay").on(t.replayId, t.startedAt)],
);

// Per-turn transcripts. Produced by the transcription stage of
// `analyze-replay`: each row is the STT output for one channel-slice of the
// uploaded stereo WAV (left for user turns, right for agent turns), bounded
// by the turn's `voice_start_ms..voice_end_ms`.
export const turnTranscripts = sqliteTable(
	"turn_transcripts",
	{
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		turnIdx: integer("turn_idx").notNull(),
		text: text("text").notNull(),
		language: text("language"),
		wordsJson: text("words_json"),
		durationMs: integer("duration_ms").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
	},
	(t) => [primaryKey({ columns: [t.replayId, t.turnIdx], name: "turn_transcripts_pk" })],
);

// Per-turn timing metrics. Produced by `calculate-metrics`.
//
// `agent_response_ms` is `voice_start_ms - prior_user_turn.voice_end_ms` for
// agent turns; null for user turns. `interrupted` is true when an
// opposite-channel speech segment started while this turn was still active.
//
// These are the audio-frame metrics — both operands of every value come from
// VAD on the same recording, so they need no cross-clock correlation. Model
// TTFT is NOT here: it's a span-level attribute on `model_usage.ttft_ms`
// (see spec 0001), surfaced on the timeline rather than aggregated per turn.
export const replayMetrics = sqliteTable(
	"replay_metrics",
	{
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		turnIdx: integer("turn_idx").notNull(),
		agentResponseMs: integer("agent_response_ms"),
		interrupted: integer("interrupted", { mode: "boolean" }).notNull(),
		interruptionStartMs: integer("interruption_start_ms"),
	},
	(t) => [primaryKey({ columns: [t.replayId, t.turnIdx], name: "replay_metrics_pk" })],
);

// One row per (replay, turn, assertion) evaluated by the server.
// `assertion_idx` is the index into the conversation turn's `assertions[]`
// array — stable across re-runs of the same conversation hash.
// `params_json` is the serialized Assertion variant (the same JSON the SDK
// posted) so a reviewer can see exactly what was evaluated without joining
// back to the conversation row.
export const assertionResults = sqliteTable(
	"assertion_results",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		turnIdx: integer("turn_idx").notNull(),
		assertionIdx: integer("assertion_idx").notNull(),
		kind: text("kind").notNull(),
		paramsJson: text("params_json").notNull(),
		status: text("status").notNull(),
		message: text("message"),
		evaluatedAt: text("evaluated_at").notNull(),
	},
	(t) => [
		index("idx_assertion_results_replay_turn").on(t.replayId, t.turnIdx),
		// One outcome per (replay, turn, assertion). The evaluate-replay
		// processor's delete-then-insert under the `analyzing` guard already
		// covers app-level idempotency; this constraint is the schema-level
		// belt-and-braces — a manual SQL write or a future code path that
		// forgets the delete still can't double-count outcomes in the
		// projection that powers `ReplayResult`.
		uniqueIndex("uq_assertion_results_replay_turn_idx").on(t.replayId, t.turnIdx, t.assertionIdx),
		check("assertion_results_status_ck", sql`${t.status} IN ('passed', 'failed', 'errored')`),
	],
);

// One row per (replay, judge). `score` is 0..100 when applicable; null on
// `errored`. `reason` is the LLM judge's explanation as returned by the
// provider.
export const judgeResults = sqliteTable(
	"judge_results",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		judgeIdx: integer("judge_idx").notNull(),
		kind: text("kind").notNull(),
		paramsJson: text("params_json").notNull(),
		status: text("status").notNull(),
		score: integer("score"),
		reason: text("reason"),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		evaluatedAt: text("evaluated_at").notNull(),
	},
	(t) => [
		index("idx_judge_results_replay").on(t.replayId),
		// One outcome per (replay, judge). Same rationale as
		// `uq_assertion_results_replay_turn_idx` — schema-level guard against
		// duplicate rows that would inflate the judge counts in
		// `replay_evaluations`.
		uniqueIndex("uq_judge_results_replay_judge_idx").on(t.replayId, t.judgeIdx),
		check("judge_results_status_ck", sql`${t.status} IN ('passed', 'failed', 'errored')`),
		check(
			"judge_results_score_ck",
			sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`,
		),
	],
);

// One row per replay. Written by `evaluate-replay` on chain completion;
// powers the `passed` boolean the SDK surfaces as `ReplayResult.passed`.
// Aggregate counts are denormalized so the inspector can render a summary
// without re-walking the per-assertion rows.
export const replayEvaluations = sqliteTable("replay_evaluations", {
	replayId: text("replay_id")
		.primaryKey()
		.references(() => replays.id, { onDelete: "cascade" }),
	passed: integer("passed", { mode: "boolean" }).notNull(),
	assertionsTotal: integer("assertions_total").notNull(),
	assertionsPassed: integer("assertions_passed").notNull(),
	judgesTotal: integer("judges_total").notNull(),
	judgesPassed: integer("judges_passed").notNull(),
	evaluatedAt: text("evaluated_at").notNull(),
});
