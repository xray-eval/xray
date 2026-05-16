import type { AgentId, ProviderId, Role } from "@/adapters/types.ts";

export type SessionSource = "adapter" | "ingest";

/**
 * A unified session record. Covers provider-adapter polls (source='adapter',
 * provider set) and HTTP ingest pushes (source='ingest', provider null).
 */
export interface Session {
	id: string;
	source: SessionSource;
	provider: ProviderId | null;
	agentId: AgentId;
	/** ISO 8601 timestamp. */
	startedAt: string;
	/** ISO 8601 timestamp; null while the session is still open. */
	endedAt: string | null;
	durationMs: number | null;
}

/**
 * One conversation step persisted in `turns`. Mirrors `Turn` from
 * `@/adapters/types.ts` but flattens tool calls into a separate table.
 */
export interface TurnRow {
	id: string;
	sessionId: string;
	/** Ordinal position within the session, 0-based. */
	idx: number;
	role: Role;
	text: string;
	/** ISO 8601 timestamp. */
	ts: string;
	activeNodeId: string | null;
	edgeFiredId: string | null;
	edgeReasoning: string | null;
	promptSeen: string | null;
	llmLatencyMs: number | null;
}

/**
 * One tool invocation persisted in `tool_calls`. `argsJson` / `resultJson`
 * stay as JSON-encoded strings — the inspector deserializes on display so
 * the DB stays schema-agnostic about tool payload shapes.
 */
export interface ToolCallRow {
	/** Auto-incrementing row id; populated by SQLite, not the caller. */
	id: number;
	turnId: string;
	idx: number;
	name: string;
	argsJson: string;
	resultJson: string | null;
	latencyMs: number | null;
}
