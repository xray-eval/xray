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
	AssertionStatus,
	JudgeStatus,
	ReplayFailureReason,
	ReplayModality,
	ReplayStatus,
	SpanVocabulary,
	TurnRole,
} from "./types.ts";

// Each `.$type<...>()` narrows the column's TypeScript type without changing
// the stored SQL type — keeps row shapes branded with the same identifiers
// the server services use end-to-end.
//
// Conventions (kept consistent with the rest of the codebase):
// - Primary keys are `text` UUIDs unless the table is a child collection
//   keyed by a parent + ordinal (e.g. `replay_turns`).
// - Timestamps are UTC ISO 8601 stored as `text`; numeric durations as
//   `integer` milliseconds.
// - JSON payloads stay as JSON-encoded `text` columns; deserialization is
//   the reader's job. SQLite's JSON1 functions are intentionally avoided
//   so a future migration to a different embedded engine has no
//   storage-engine-specific surface to port.

// Conversations — dev-authored test definitions
//
// Composite primary key `(id, version)`: the dev controls `id`, the SDK
// computes `version` as a fingerprint over turn structure. Two POSTs with
// the same `(id, version)` upsert idempotently; an upsert against an
// existing `(id, version)` with a different `turns_json` is rejected by
// the service as `VersionFingerprintMismatchError`.
export const conversations = sqliteTable(
	"conversations",
	{
		id: text("id").notNull(),
		version: text("version").notNull(),
		// JSON-encoded array of turn descriptors. Schema validated at the wire
		// boundary; storage is opaque to the DB.
		turnsJson: text("turns_json").notNull(),
		title: text("title"),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.id, t.version], name: "conversations_pk" }),
		index("idx_conversations_id_created_at").on(t.id, t.createdAt),
	],
);

// Replays — one execution of one Conversation
//
// `conversation_id` + `conversation_version` together reference a row in
// `conversations`. We do NOT declare it as a composite FK because Drizzle's
// SQLite dialect spells composite FKs inconsistently across versions; the
// service validates the (id, version) pair on insert.
export const replays = sqliteTable(
	"replays",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		conversationVersion: text("conversation_version").notNull(),
		status: text("status").$type<ReplayStatus>().notNull(),
		failureReason: text("failure_reason").$type<ReplayFailureReason | null>(),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
		// Path under XRAY_AUDIO_ROOT to the full-replay audio mixdown, if any.
		// Per-turn segments live on `replay_turns`.
		audioPath: text("audio_path"),
		transcript: text("transcript"),
	},
	(t) => [
		index("idx_replays_conversation").on(t.conversationId, t.conversationVersion, t.startedAt),
		index("idx_replays_started_at").on(t.startedAt),
		check("replays_status_ck", sql`${t.status} IN ('running', 'completed', 'failed')`),
	],
);

// Replay meta — 1:1 side table for fields that change after the row exists
//
// Split out so creating a replay (single insert into `replays`) is cheap and
// the read-heavy fields (status chip, judge result, run_config diff in the UI)
// can be updated without rewriting the main row's wide audio/transcript blobs.
export const replayMeta = sqliteTable(
	"replay_meta",
	{
		replayId: text("replay_id")
			.primaryKey()
			.references(() => replays.id, { onDelete: "cascade" }),
		modality: text("modality").$type<ReplayModality>().notNull().default("voice"),
		// Dev-supplied snapshot of the system-under-test's external config
		// (env vars, model rev, feature flags) at run start. Diffed in the UI
		// between replays; opaque to xray.
		runConfigJson: text("run_config_json"),
		judgeStatus: text("judge_status").$type<JudgeStatus | null>(),
		judgeScore: integer("judge_score"),
		judgeReason: text("judge_reason"),
		judgeError: text("judge_error"),
	},
	(t) => [check("replay_meta_modality_ck", sql`${t.modality} IN ('voice')`)],
);

// Replay turns — per-turn audio segments + transcripts + cross-replay key
//
// `idx` is the ordinal within the replay (0-based). `key` is a dev-declared
// cross-Conversation alignment key; the UI joins on it for compare views.
export const replayTurns = sqliteTable(
	"replay_turns",
	{
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		idx: integer("idx").notNull(),
		role: text("role").$type<TurnRole>().notNull(),
		// Optional cross-replay/cross-conversation alignment key.
		key: text("key"),
		startedAt: text("started_at"),
		endedAt: text("ended_at"),
		transcript: text("transcript"),
		audioPath: text("audio_path"),
	},
	(t) => [
		primaryKey({ columns: [t.replayId, t.idx], name: "replay_turns_pk" }),
		index("idx_replay_turns_replay_idx").on(t.replayId, t.idx),
		check("replay_turns_role_ck", sql`${t.role} IN ('user', 'agent')`),
	],
);

// Spans — recognized OTLP spans persisted under a replay
//
// One row per accepted span. Unrecognized vocabularies are dropped at the
// OTLP receiver and never reach this table.
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
		// JSON-encoded attribute bag, post-filter (only the fields the
		// vocabulary recognized).
		attributesJson: text("attributes_json").notNull(),
	},
	(t) => [
		index("idx_spans_replay_started").on(t.replayId, t.startedAt),
		index("idx_spans_trace").on(t.traceId),
		unique("spans_replay_span_uk").on(t.replayId, t.spanId),
		check("spans_vocabulary_ck", sql`${t.vocabulary} IN ('xray', 'gen_ai', 'langfuse')`),
	],
);

// Tool calls — extracted from gen_ai / langfuse / xray.* tool-call spans
export const toolCalls = sqliteTable(
	"tool_calls",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		// Optional pointer to the replay_turn this call landed under, by ordinal.
		// Some span vocabularies don't carry per-turn context; that's fine.
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

// Model usage — extracted from gen_ai / langfuse LLM-call spans
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

// Assertions — per-turn predicate results posted by the SDK as xray.* spans
export const assertions = sqliteTable(
	"assertions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		replayId: text("replay_id")
			.notNull()
			.references(() => replays.id, { onDelete: "cascade" }),
		turnIdx: integer("turn_idx").notNull(),
		name: text("name").notNull(),
		status: text("status").$type<AssertionStatus>().notNull(),
		message: text("message"),
		recordedAt: text("recorded_at").notNull(),
	},
	(t) => [
		index("idx_assertions_replay_turn").on(t.replayId, t.turnIdx),
		unique("assertions_replay_turn_name_uk").on(t.replayId, t.turnIdx, t.name),
		check("assertions_status_ck", sql`${t.status} IN ('passed', 'failed', 'errored')`),
	],
);
