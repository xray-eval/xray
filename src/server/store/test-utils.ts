import type { Store } from "./store.ts";
import { openStore } from "./store.ts";
import type { Session, ToolCallRow, TurnRow } from "./types.ts";

/**
 * In-memory store for a single test. Each call returns a fresh DB — no
 * cleanup needed; the OS frees memory on close.
 */
export function makeTempStore(): Store {
	return openStore({ path: ":memory:" });
}

let sessionCounter = 0;
let turnCounter = 0;

export function makeSession(overrides: Partial<Session> = {}): Session {
	sessionCounter += 1;
	return {
		id: `sess-${sessionCounter}`,
		source: "ingest",
		provider: null,
		agentId: "agent-1",
		startedAt: "2026-05-16T12:00:00.000Z",
		endedAt: null,
		durationMs: null,
		...overrides,
	};
}

export function makeTurnRow(overrides: Partial<TurnRow> = {}): TurnRow {
	turnCounter += 1;
	return {
		id: `turn-${turnCounter}`,
		sessionId: "sess-1",
		idx: 0,
		role: "user",
		text: "hello",
		ts: "2026-05-16T12:00:01.000Z",
		activeNodeId: null,
		edgeFiredId: null,
		edgeReasoning: null,
		promptSeen: null,
		llmLatencyMs: null,
		...overrides,
	};
}

/**
 * Builder for input rows handed to `appendToolCalls`. The `id` field is
 * populated by SQLite, not callers, so it's omitted here.
 */
export type ToolCallInput = Omit<ToolCallRow, "id">;

export function makeToolCallInput(overrides: Partial<ToolCallInput> = {}): ToolCallInput {
	return {
		turnId: "turn-1",
		idx: 0,
		name: "lookup",
		argsJson: '{"q":"hello"}',
		resultJson: null,
		latencyMs: null,
		...overrides,
	};
}
