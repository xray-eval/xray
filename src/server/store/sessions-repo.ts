import { and, desc, eq } from "drizzle-orm";

import type { AgentId } from "@/adapters/types.ts";

import { sessions } from "./schema.ts";
import type { StoreDb } from "./store.ts";
import type { Session, SessionSource } from "./types.ts";

/**
 * Insert or replace a session by primary key. Used by both adapters (whose
 * polls may re-emit the same session id with updated `endedAt`) and ingest
 * (where `session_started` and a later `session_ended` arrive separately).
 */
export function saveSession(db: StoreDb, session: Session): void {
	db.insert(sessions)
		.values(session)
		.onConflictDoUpdate({
			target: sessions.id,
			set: {
				source: session.source,
				provider: session.provider,
				agentId: session.agentId,
				startedAt: session.startedAt,
				endedAt: session.endedAt,
				durationMs: session.durationMs,
			},
		})
		.run();
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
