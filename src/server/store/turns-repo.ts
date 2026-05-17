import { and, asc, eq } from "drizzle-orm";

import { turns } from "./schema.ts";
import type { StoreDb } from "./store.ts";
import type { TurnInput, TurnRow } from "./types.ts";

/**
 * Append a batch of turns to one session, in one transaction. If any row in
 * the batch violates the `UNIQUE(session_id, idx)` constraint, the whole
 * batch rolls back — partial appends would corrupt the ordering invariant.
 */
export function appendTurns(db: StoreDb, sessionId: string, batch: TurnInput[]): void {
	if (batch.length === 0) return;
	const rows = batch.map((t) => ({ ...t, sessionId }));
	db.transaction((tx) => {
		tx.insert(turns).values(rows).run();
	});
}

/**
 * Append one turn. On `UNIQUE(session_id, idx)` collision the insert is
 * silently dropped — the ingest path's idempotency contract: replaying the
 * same `(session_id, idx)` is a no-op.
 */
export function appendTurnIdempotent(db: StoreDb, sessionId: string, turn: TurnInput): void {
	db.insert(turns)
		.values({ ...turn, sessionId })
		.onConflictDoNothing({ target: [turns.sessionId, turns.idx] })
		.run();
}

export function getTurnByIdx(db: StoreDb, sessionId: string, idx: number): TurnRow | undefined {
	return db
		.select()
		.from(turns)
		.where(and(eq(turns.sessionId, sessionId), eq(turns.idx, idx)))
		.get();
}

export function listTurnsForSession(db: StoreDb, sessionId: string): TurnRow[] {
	return db
		.select()
		.from(turns)
		.where(eq(turns.sessionId, sessionId))
		.orderBy(asc(turns.idx))
		.all();
}

/**
 * Stamp the on-disk location of the turn's uploaded audio. Returns `true`
 * iff a row matched — callers (the audio service) write the file first and
 * then call this so the existence check + DB write happen as one step. A
 * `false` return means the turn vanished between disk write and DB write
 * (concurrent session delete), and the caller cleans up the orphan file.
 */
export function setTurnAudioPath(
	db: StoreDb,
	sessionId: string,
	idx: number,
	audioPath: string,
): boolean {
	const rows = db
		.update(turns)
		.set({ audioPath })
		.where(and(eq(turns.sessionId, sessionId), eq(turns.idx, idx)))
		.returning({ id: turns.id })
		.all();
	return rows.length > 0;
}
