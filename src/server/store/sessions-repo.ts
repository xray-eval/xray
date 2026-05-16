import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import type { AgentId } from "@/adapters/types.ts";

import { sessions } from "./schema.ts";
import type { StoreDb } from "./store.ts";
import type { Session, SessionSource } from "./types.ts";

/**
 * Insert or replace a session by primary key. Used by both adapters (whose
 * polls may re-emit the same session id with updated `endedAt`) and ingest
 * (where `session_started` and a later `session_ended` arrive separately).
 *
 * Stickiness rules on upsert:
 * - `startedAt` is **MIN-merged**: a stub (created on first turn with
 *   `startedAt = turn.ts`) must not be pushed forward by a later
 *   `session_started` whose own startedAt is past an already-recorded
 *   turn. `MIN(...)` keeps `startedAt <= min(turn.ts)` as an invariant.
 * - `endedAt` / `durationMs` are sticky via `COALESCE`: once set, a later
 *   write with a null value won't unset them. A session that has ended
 *   cannot un-end.
 *
 * Other columns use last-writer-wins — adapters don't change them in
 * practice.
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
				startedAt: sql`MIN(excluded.started_at, ${sessions.startedAt})`,
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

/**
 * Stamp end-of-session metadata. No-op if `id` does not exist, AND no-op
 * if the session already has an `endedAt` — once a session has ended it
 * cannot un-end, and a retried `session_ended` must not overwrite the
 * canonical end time.
 */
export function markSessionEnded(
	db: StoreDb,
	id: string,
	endedAt: string,
	durationMs: number,
): void {
	db.update(sessions)
		.set({ endedAt, durationMs })
		.where(and(eq(sessions.id, id), isNull(sessions.endedAt)))
		.run();
}

export function getSession(db: StoreDb, id: string): Session | undefined {
	return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export interface SessionCursor {
	/** ISO 8601 `started_at` of the last row from the previous page. */
	startedAt: string;
	/** `id` of the last row from the previous page — tie-breaker when timestamps match. */
	id: string;
}

export interface ListSessionsOptions {
	source?: SessionSource;
	agentId?: AgentId;
	/** Defaults to 100. */
	limit?: number;
	/** Opaque cursor: rows strictly older than this `(startedAt, id)` pair. */
	cursor?: SessionCursor;
}

export function listSessions(db: StoreDb, opts: ListSessionsOptions = {}): Session[] {
	// started_at is ISO 8601 — lexicographic sort matches chronological sort,
	// so SQLite's TEXT comparison is sufficient. id breaks ties so pagination
	// is deterministic when many sessions share a startedAt.
	const filters = [
		opts.source !== undefined ? eq(sessions.source, opts.source) : undefined,
		opts.agentId !== undefined ? eq(sessions.agentId, opts.agentId) : undefined,
		opts.cursor !== undefined
			? or(
					sql`${sessions.startedAt} < ${opts.cursor.startedAt}`,
					and(
						eq(sessions.startedAt, opts.cursor.startedAt),
						sql`${sessions.id} < ${opts.cursor.id}`,
					),
				)
			: undefined,
	].filter((c) => c !== undefined);
	return db
		.select()
		.from(sessions)
		.where(filters.length > 0 ? and(...filters) : undefined)
		.orderBy(desc(sessions.startedAt), desc(sessions.id))
		.limit(opts.limit ?? 100)
		.all();
}
