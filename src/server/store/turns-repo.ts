import type { Role } from "@/adapters/types.ts";

import type { TurnRow } from "./types.ts";
import type { Database } from "bun:sqlite";

interface TurnDbRow {
	id: string;
	session_id: string;
	idx: number;
	role: Role;
	text: string;
	ts: string;
	active_node_id: string | null;
	edge_fired_id: string | null;
	edge_reasoning: string | null;
	prompt_seen: string | null;
	llm_latency_ms: number | null;
}

const SELECT_COLS =
	"id, session_id, idx, role, text, ts, active_node_id, edge_fired_id, edge_reasoning, prompt_seen, llm_latency_ms";

/** Builder shape callers hand to `appendTurns` — `sessionId` is filled by the repo. */
export type TurnInput = Omit<TurnRow, "sessionId">;

/**
 * Append a batch of turns to one session, in one transaction. If any row in
 * the batch violates the `UNIQUE(session_id, idx)` constraint, the whole
 * batch rolls back — partial appends would corrupt the ordering invariant.
 */
export function appendTurns(db: Database, sessionId: string, turns: TurnInput[]): void {
	if (turns.length === 0) return;
	const insert = db.prepare(
		`INSERT INTO turns (
			id, session_id, idx, role, text, ts,
			active_node_id, edge_fired_id, edge_reasoning, prompt_seen, llm_latency_ms
		) VALUES (
			$id, $session_id, $idx, $role, $text, $ts,
			$active_node_id, $edge_fired_id, $edge_reasoning, $prompt_seen, $llm_latency_ms
		)`,
	);
	const insertMany = db.transaction((batch: TurnInput[]) => {
		for (const t of batch) {
			insert.run({
				id: t.id,
				session_id: sessionId,
				idx: t.idx,
				role: t.role,
				text: t.text,
				ts: t.ts,
				active_node_id: t.activeNodeId,
				edge_fired_id: t.edgeFiredId,
				edge_reasoning: t.edgeReasoning,
				prompt_seen: t.promptSeen,
				llm_latency_ms: t.llmLatencyMs,
			});
		}
	});
	insertMany(turns);
}

export function listTurnsForSession(db: Database, sessionId: string): TurnRow[] {
	const rows = db
		.prepare<TurnDbRow, [string]>(
			`SELECT ${SELECT_COLS} FROM turns WHERE session_id = ? ORDER BY idx ASC`,
		)
		.all(sessionId);
	return rows.map(rowToTurn);
}

function rowToTurn(r: TurnDbRow): TurnRow {
	return {
		id: r.id,
		sessionId: r.session_id,
		idx: r.idx,
		role: r.role,
		text: r.text,
		ts: r.ts,
		activeNodeId: r.active_node_id,
		edgeFiredId: r.edge_fired_id,
		edgeReasoning: r.edge_reasoning,
		promptSeen: r.prompt_seen,
		llmLatencyMs: r.llm_latency_ms,
	};
}
