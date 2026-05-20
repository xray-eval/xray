import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
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

export const conversations = sqliteTable(
	"conversations",
	{
		id: text("id").notNull(),
		version: text("version").notNull(),
		turnsJson: text("turns_json").notNull(),
		title: text("title"),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.id, t.version], name: "conversations_pk" }),
		index("idx_conversations_id_created_at").on(t.id, t.createdAt),
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
		conversationId: text("conversation_id").notNull(),
		conversationVersion: text("conversation_version").notNull(),
		lifecycleState: text("lifecycle_state").$type<ReplayLifecycleState>().notNull(),
		// Current analysis sub-step, surfaced over SSE. Null outside `analyzing`.
		analysisStep: text("analysis_step").$type<AnalysisStep | null>(),
		failureReason: text("failure_reason").$type<ReplayFailureReason | null>(),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
		// Path under XRAY_AUDIO_ROOT to the uploaded stereo WAV.
		audioPath: text("audio_path"),
		// Opaque dev-side snapshot of the SUT config at run start.
		runConfigJson: text("run_config_json"),
		// bunqueue job id assigned when /analyze is invoked. Null until then.
		jobId: text("job_id"),
	},
	(t) => [
		index("idx_replays_conversation").on(t.conversationId, t.conversationVersion, t.startedAt),
		index("idx_replays_started_at").on(t.startedAt),
		check(
			"replays_lifecycle_state_ck",
			sql`${t.lifecycleState} IN ('pending', 'running', 'recording_uploaded', 'analyzing', 'completed', 'failed')`,
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
		index("idx_replay_turns_replay_idx").on(t.replayId, t.idx),
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
		turnIdx: integer("turn_idx"),
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
		turnIdx: integer("turn_idx"),
		spanId: text("span_id"),
		provider: text("provider"),
		model: text("model"),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		totalTokens: integer("total_tokens"),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		latencyMs: integer("latency_ms"),
	},
	(t) => [index("idx_model_usage_replay").on(t.replayId, t.startedAt)],
);
