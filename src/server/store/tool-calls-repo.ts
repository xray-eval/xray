import type { ToolCallRow } from "./types.ts";
import type { Database } from "bun:sqlite";

interface ToolCallDbRow {
	id: number;
	turn_id: string;
	idx: number;
	name: string;
	args_json: string;
	result_json: string | null;
	latency_ms: number | null;
}

const SELECT_COLS = "id, turn_id, idx, name, args_json, result_json, latency_ms";

/** Builder shape for `appendToolCalls`. `id` is auto-assigned by SQLite; `turnId` comes from the arg. */
export type ToolCallInput = Omit<ToolCallRow, "id" | "turnId">;

/**
 * Append a batch of tool calls for one turn, in one transaction. Rolls back
 * the whole batch on any UNIQUE(turn_id, idx) collision — same reasoning as
 * `appendTurns`: partial inserts would scramble the call order.
 */
export function appendToolCalls(db: Database, turnId: string, calls: ToolCallInput[]): void {
	if (calls.length === 0) return;
	const insert = db.prepare(
		`INSERT INTO tool_calls (turn_id, idx, name, args_json, result_json, latency_ms)
		 VALUES ($turn_id, $idx, $name, $args_json, $result_json, $latency_ms)`,
	);
	const insertMany = db.transaction((batch: ToolCallInput[]) => {
		for (const c of batch) {
			insert.run({
				turn_id: turnId,
				idx: c.idx,
				name: c.name,
				args_json: c.argsJson,
				result_json: c.resultJson,
				latency_ms: c.latencyMs,
			});
		}
	});
	insertMany(calls);
}

export function listToolCallsForTurn(db: Database, turnId: string): ToolCallRow[] {
	const rows = db
		.prepare<ToolCallDbRow, [string]>(
			`SELECT ${SELECT_COLS} FROM tool_calls WHERE turn_id = ? ORDER BY idx ASC`,
		)
		.all(turnId);
	return rows.map(rowToToolCall);
}

function rowToToolCall(r: ToolCallDbRow): ToolCallRow {
	return {
		id: r.id,
		turnId: r.turn_id,
		idx: r.idx,
		name: r.name,
		argsJson: r.args_json,
		resultJson: r.result_json,
		latencyMs: r.latency_ms,
	};
}
