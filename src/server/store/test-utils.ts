import type { Store } from "./store.ts";
import { openStore } from "./store.ts";
import type { Session, ToolCallInput, TurnInput } from "./types.ts";

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

export function makeTurnInput(overrides: Partial<TurnInput> = {}): TurnInput {
	turnCounter += 1;
	return {
		id: `turn-${turnCounter}`,
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

export function makeToolCallInput(overrides: Partial<ToolCallInput> = {}): ToolCallInput {
	return {
		idx: 0,
		name: "lookup",
		argsJson: '{"q":"hello"}',
		resultJson: null,
		latencyMs: null,
		...overrides,
	};
}
