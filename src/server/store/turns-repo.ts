import { asc, eq } from "drizzle-orm";

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

export function listTurnsForSession(db: StoreDb, sessionId: string): TurnRow[] {
	return db
		.select()
		.from(turns)
		.where(eq(turns.sessionId, sessionId))
		.orderBy(asc(turns.idx))
		.all();
}
