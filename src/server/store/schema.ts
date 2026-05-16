import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

import type { AgentId, ProviderId, Role } from "@/adapters/types.ts";

import type { SessionSource } from "./types.ts";

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
		llmLatencyMs: integer("llm_latency_ms"),
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
