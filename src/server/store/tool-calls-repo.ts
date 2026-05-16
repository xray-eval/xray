import { asc, eq } from "drizzle-orm";

import { toolCalls } from "./schema.ts";
import type { StoreDb } from "./store.ts";
import type { ToolCallInput, ToolCallRow } from "./types.ts";

/**
 * Append a batch of tool calls for one turn, in one transaction. Rolls back
 * the whole batch on any UNIQUE(turn_id, idx) collision — same reasoning as
 * `appendTurns`: partial inserts would scramble the call order.
 */
export function appendToolCalls(db: StoreDb, turnId: string, batch: ToolCallInput[]): void {
	if (batch.length === 0) return;
	const rows = batch.map((c) => ({ ...c, turnId }));
	db.transaction((tx) => {
		tx.insert(toolCalls).values(rows).run();
	});
}

export function listToolCallsForTurn(db: StoreDb, turnId: string): ToolCallRow[] {
	return db
		.select()
		.from(toolCalls)
		.where(eq(toolCalls.turnId, turnId))
		.orderBy(asc(toolCalls.idx))
		.all();
}
