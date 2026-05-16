import { and, desc, eq, sql } from "drizzle-orm";

import type { AgentId } from "@/adapters/types.ts";

import { sessions } from "./schema.ts";
import type { StoreDb } from "./store.ts";
import type { Session, SessionSource } from "./types.ts";

/**
 * Insert or replace a session by primary key. Used by both adapters (whose
 * polls may re-emit the same session id with updated `endedAt`) and ingest
 * (where `session_started` and a later `session_ended` arrive separately).
 *
 * `endedAt` and `durationMs` are **sticky**: once set, a later write with a
 * null value won't unset them. A session that has ended cannot un-end, so
 * an out-of-order poll returning an in-progress snapshot must not regress
 * the canonical end time. Other columns use last-writer-wins — adapters
 * don't change them in practice.
 */
export function saveSession(db: StoreDb, session: Session): void {
	db.insert(sessions)
		.values(session)
		.onConflictDoUpdate({
			target: sessions.id,
			set: {
				source: sql`excluded.source`,
				provider: sql`excluded.provider`,
				agentId: sql`excluded.agent_id`,
				startedAt: sql`excluded.started_at`,
				endedAt: sql`COALESCE(excluded.ended_at, ${sessions.endedAt})`,
				durationMs: sql`COALESCE(excluded.duration_ms, ${sessions.durationMs})`,
			},
		})
		.run();
}

/**
 * INSERT-OR-IGNORE a placeholder session. Used by the ingest path when an
 * event (turn, tool call, session_ended) arrives before an explicit
 * `session_started`. The `agentId="unknown"` row is overwritten by a later
 * `saveSession` call once the real metadata arrives.
 */
export function ensureStubSession(db: StoreDb, id: string, startedAt: string): void {
	db.insert(sessions)
		.values({
			id,
			source: "ingest",
			provider: null,
			agentId: "unknown",
			startedAt,
			endedAt: null,
			durationMs: null,
		})
		.onConflictDoNothing({ target: sessions.id })
		.run();
}

/** Stamp end-of-session metadata. No-op if `id` does not exist. */
export function markSessionEnded(
	db: StoreDb,
	id: string,
	endedAt: string,
	durationMs: number,
): void {
	db.update(sessions).set({ endedAt, durationMs }).where(eq(sessions.id, id)).run();
}

export function getSession(db: StoreDb, id: string): Session | undefined {
	return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export interface ListSessionsOptions {
	source?: SessionSource;
	agentId?: AgentId;
	/** Defaults to 100. */
	limit?: number;
}

export function listSessions(db: StoreDb, opts: ListSessionsOptions = {}): Session[] {
	const filters = [
		opts.source !== undefined ? eq(sessions.source, opts.source) : undefined,
		opts.agentId !== undefined ? eq(sessions.agentId, opts.agentId) : undefined,
	].filter((c) => c !== undefined);
	// started_at is ISO 8601 — lexicographic sort matches chronological sort,
	// so SQLite's TEXT comparison is sufficient.
	return db
		.select()
		.from(sessions)
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(desc(sessions.startedAt))
		.limit(opts.limit ?? 100)
		.all();
}
