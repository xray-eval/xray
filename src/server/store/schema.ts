import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

import type { AgentId, ProviderId, Role } from "@/adapters/types.ts";

import type { ReplayRunMode, ReplayRunStatus, SessionSource } from "./types.ts";

// Each `.$type<...>()` narrows the column's TypeScript type without affecting
// the stored SQL type — keeps the row shapes branded with the same identifiers
// the adapters use, so the same `ProviderId` / `Role` flow end-to-end.

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		source: text("source").$type<SessionSource>().notNull(),
		provider: text("provider").$type<ProviderId | null>(),
		agentId: text("agent_id").$type<AgentId>().notNull(),
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at"),
		durationMs: integer("duration_ms"),
	},
	(t) => [
		index("idx_sessions_started_at").on(t.startedAt),
		check("sessions_source_ck", sql`${t.source} IN ('adapter', 'ingest')`),
	],
);

export const turns = sqliteTable(
	"turns",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		// Ordinal position within the session (0-based). UNIQUE so repeat appends
		// with the same idx are caught by the DB, not by application code.
		idx: integer("idx").notNull(),
		role: text("role").$type<Role>().notNull(),
		text: text("text").notNull(),
		ts: text("ts").notNull(),
		activeNodeId: text("active_node_id"),
		edgeFiredId: text("edge_fired_id"),
		edgeReasoning: text("edge_reasoning"),
		promptSeen: text("prompt_seen"),
		responseLatencyMs: integer("response_latency_ms"),
		interrupted: integer("interrupted", { mode: "boolean" }),
		interruptedAtMs: integer("interrupted_at_ms"),
		// Relative to the audio root; bytes live on the mounted volume, not
		// in SQLite (BLOBs > a few MB are a SQLite anti-pattern).
		audioPath: text("audio_path"),
	},
	(t) => [
		index("idx_turns_session_idx").on(t.sessionId, t.idx),
		unique("turns_session_idx_uk").on(t.sessionId, t.idx),
		check("turns_role_ck", sql`${t.role} IN ('user', 'agent', 'tool', 'system')`),
	],
);

export const toolCalls = sqliteTable(
	"tool_calls",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		turnId: text("turn_id")
			.notNull()
			.references(() => turns.id, { onDelete: "cascade" }),
		idx: integer("idx").notNull(),
		name: text("name").notNull(),
		argsJson: text("args_json").notNull(),
		resultJson: text("result_json"),
		latencyMs: integer("latency_ms"),
	},
	(t) => [
		index("idx_tool_calls_turn_idx").on(t.turnId, t.idx),
		unique("tool_calls_turn_idx_uk").on(t.turnId, t.idx),
	],
);

// `target_session_id` is NOT an FK to sessions.id: the worker creates the
// target row lazily through the ingest path on its first event. An FK would
// force the writer to pre-insert a stub purely to satisfy referential
// integrity, which is the opposite of how ingest's "stub on first event"
// model works for every other session.
//
// On startup we sweep any `status='running'` row to `failed` — a single Bun
// process owns the DB (per single-image-distribution.md), so any "running"
// state on boot is by definition from a previous, now-dead worker.
export const replayRuns = sqliteTable(
	"replay_runs",
	{
		id: text("id").primaryKey(),
		sourceSessionId: text("source_session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		targetSessionId: text("target_session_id").notNull().unique(),
		status: text("status").$type<ReplayRunStatus>().notNull(),
		// Default 'text' so existing rows pre-dating realtime replay get the
		// right value on migration without a hand-written backfill.
		mode: text("mode").$type<ReplayRunMode>().notNull().default("text"),
		webhookUrl: text("webhook_url").notNull(),
		progressCompleted: integer("progress_completed").notNull().default(0),
		progressTotal: integer("progress_total").notNull(),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
		error: text("error"),
	},
	(t) => [
		index("idx_replay_runs_source").on(t.sourceSessionId),
		index("idx_replay_runs_started_at").on(t.startedAt),
		check(
			"replay_runs_status_ck",
			sql`${t.status} IN ('pending', 'running', 'completed', 'failed')`,
		),
		// No CHECK on `mode` — would force a table rebuild on every migration that
		// touches replay_runs. TS `$type<ReplayRunMode>()` + Valibot picklist at
		// the boundary enforce the value set; nothing inside our process writes a
		// raw string here.
	],
);
