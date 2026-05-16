import type { AgentId, ProviderId } from "@/adapters/types.ts";

import type { Session, SessionSource } from "./types.ts";
import type { Database } from "bun:sqlite";

interface SessionDbRow {
	id: string;
	source: SessionSource;
	provider: ProviderId | null;
	agent_id: AgentId;
	started_at: string;
	ended_at: string | null;
	duration_ms: number | null;
}

const SELECT_COLS = "id, source, provider, agent_id, started_at, ended_at, duration_ms";

/**
 * Insert or replace a session by primary key. Used by both adapters (whose
 * polls may re-emit the same session id with updated `endedAt`) and ingest
 * (where `session_started` and a later `session_ended` arrive separately).
 */
export function saveSession(db: Database, session: Session): void {
	db.prepare(
		`INSERT INTO sessions (id, source, provider, agent_id, started_at, ended_at, duration_ms)
		 VALUES ($id, $source, $provider, $agent_id, $started_at, $ended_at, $duration_ms)
		 ON CONFLICT(id) DO UPDATE SET
			source = excluded.source,
			provider = excluded.provider,
			agent_id = excluded.agent_id,
			started_at = excluded.started_at,
			ended_at = excluded.ended_at,
			duration_ms = excluded.duration_ms`,
	).run({
		id: session.id,
		source: session.source,
		provider: session.provider,
		agent_id: session.agentId,
		started_at: session.startedAt,
		ended_at: session.endedAt,
		duration_ms: session.durationMs,
	});
}

export function getSession(db: Database, id: string): Session | undefined {
	const row = db
		.prepare<SessionDbRow, [string]>(`SELECT ${SELECT_COLS} FROM sessions WHERE id = ?`)
		.get(id);
	return row ? rowToSession(row) : undefined;
}

export interface ListSessionsOptions {
	source?: SessionSource;
	agentId?: AgentId;
	/** Defaults to 100. SQLite handles `LIMIT -1` as "no limit"; we cap explicitly. */
	limit?: number;
}

export function listSessions(db: Database, opts: ListSessionsOptions = {}): Session[] {
	const conditions: string[] = [];
	if (opts.source !== undefined) conditions.push("source = $source");
	if (opts.agentId !== undefined) conditions.push("agent_id = $agent_id");
	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	// started_at is ISO 8601 — lexicographic sort matches chronological sort,
	// so no extra date parsing is needed in SQL. Unused named params (source /
	// agent_id when filters are off) bind to null; SQLite ignores them when
	// they don't appear in the prepared statement.
	const rows = db
		.prepare<SessionDbRow, Record<string, string | number | null>>(
			`SELECT ${SELECT_COLS} FROM sessions ${where} ORDER BY started_at DESC LIMIT $limit`,
		)
		.all({
			source: opts.source ?? null,
			agent_id: opts.agentId ?? null,
			limit: opts.limit ?? 100,
		});
	return rows.map(rowToSession);
}

function rowToSession(r: SessionDbRow): Session {
	return {
		id: r.id,
		source: r.source,
		provider: r.provider,
		agentId: r.agent_id,
		startedAt: r.started_at,
		endedAt: r.ended_at,
		durationMs: r.duration_ms,
	};
}
