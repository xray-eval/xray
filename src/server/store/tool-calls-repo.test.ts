import { turns } from "./schema.ts";
import { saveSession } from "./sessions-repo.ts";
import { makeSession, makeTempStore, makeToolCallInput, makeTurnInput } from "./test-utils.ts";
import {
	appendToolCallIdempotent,
	appendToolCalls,
	listToolCallsForSession,
	listToolCallsForTurn,
} from "./tool-calls-repo.ts";
import { appendTurns } from "./turns-repo.ts";
import { describe, expect, it } from "bun:test";

function seedSessionWithTurn(turnId: string) {
	const store = makeTempStore();
	saveSession(store.db, makeSession({ id: "sess-1" }));
	appendTurns(store.db, "sess-1", [makeTurnInput({ id: turnId, idx: 0 })]);
	return store;
}

describe("tool-calls-repo", () => {
	it("appends and lists tool calls in idx order", () => {
		const store = seedSessionWithTurn("turn-A");
		appendToolCalls(store.db, "turn-A", [
			makeToolCallInput({ idx: 1, name: "second", argsJson: '{"b":2}' }),
			makeToolCallInput({ idx: 0, name: "first", argsJson: '{"a":1}' }),
		]);
		const rows = listToolCallsForTurn(store.db, "turn-A");
		expect(rows.map((r) => r.name)).toEqual(["first", "second"]);
		expect(rows.every((r) => r.turnId === "turn-A")).toBe(true);
		// `id` is auto-assigned by SQLite — just check that it was populated.
		expect(rows.every((r) => typeof r.id === "number")).toBe(true);
		store.close();
	});

	it("stores nullable result_json and latency_ms", () => {
		const store = seedSessionWithTurn("turn-A");
		appendToolCalls(store.db, "turn-A", [
			makeToolCallInput({
				idx: 0,
				name: "lookup",
				argsJson: "{}",
				resultJson: '{"ok":true}',
				latencyMs: 42,
			}),
			makeToolCallInput({ idx: 1, name: "pending", argsJson: "{}" }),
		]);
		const [done, pending] = listToolCallsForTurn(store.db, "turn-A");
		expect(done?.resultJson).toBe('{"ok":true}');
		expect(done?.latencyMs).toBe(42);
		expect(pending?.resultJson).toBeNull();
		expect(pending?.latencyMs).toBeNull();
		store.close();
	});

	it("no-ops on empty input", () => {
		const store = seedSessionWithTurn("turn-A");
		expect(() => appendToolCalls(store.db, "turn-A", [])).not.toThrow();
		expect(listToolCallsForTurn(store.db, "turn-A")).toEqual([]);
		store.close();
	});

	it("rolls back the whole batch on UNIQUE(turn_id, idx) collision", () => {
		const store = seedSessionWithTurn("turn-A");
		appendToolCalls(store.db, "turn-A", [makeToolCallInput({ idx: 0, name: "first" })]);

		expect(() =>
			appendToolCalls(store.db, "turn-A", [
				makeToolCallInput({ idx: 1, name: "second" }),
				makeToolCallInput({ idx: 0, name: "duplicate" }),
			]),
		).toThrow();

		const names = listToolCallsForTurn(store.db, "turn-A").map((r) => r.name);
		expect(names).toEqual(["first"]);
		store.close();
	});

	it("appendToolCallIdempotent drops duplicate (turn_id, idx) silently", () => {
		// The ingest path's retry-safety contract: replaying the same
		// `tool_called` event (same `turnIdx` + client-supplied `idx`) must
		// not duplicate the row and must not throw.
		const store = seedSessionWithTurn("turn-A");
		appendToolCallIdempotent(store.db, "turn-A", makeToolCallInput({ idx: 0, name: "first" }));
		appendToolCallIdempotent(
			store.db,
			"turn-A",
			makeToolCallInput({ idx: 0, name: "first-replayed" }),
		);
		const rows = listToolCallsForTurn(store.db, "turn-A");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("first");
		store.close();
	});

	it("rejects tool calls whose turn does not exist (FK)", () => {
		const store = seedSessionWithTurn("turn-A");
		expect(() =>
			appendToolCalls(store.db, "missing-turn", [makeToolCallInput({ idx: 0 })]),
		).toThrow();
		store.close();
	});

	it("cascades when the parent turn is deleted", () => {
		const store = seedSessionWithTurn("turn-A");
		appendToolCalls(store.db, "turn-A", [makeToolCallInput({ idx: 0 })]);
		store.db.delete(turns).run();
		expect(listToolCallsForTurn(store.db, "turn-A")).toEqual([]);
		store.close();
	});

	it("listToolCallsForSession orders by (turn.idx, tool_call.idx) across turns", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "sess-X" }));
		appendTurns(store.db, "sess-X", [
			makeTurnInput({ id: "t-1", idx: 1 }),
			makeTurnInput({ id: "t-0", idx: 0 }),
		]);
		appendToolCalls(store.db, "t-1", [
			makeToolCallInput({ idx: 0, name: "t1-c0" }),
			makeToolCallInput({ idx: 1, name: "t1-c1" }),
		]);
		appendToolCalls(store.db, "t-0", [
			makeToolCallInput({ idx: 1, name: "t0-c1" }),
			makeToolCallInput({ idx: 0, name: "t0-c0" }),
		]);
		const rows = listToolCallsForSession(store.db, "sess-X");
		expect(rows.map((r) => r.name)).toEqual(["t0-c0", "t0-c1", "t1-c0", "t1-c1"]);
		store.close();
	});

	it("listToolCallsForSession returns an empty array for a session with no tool calls", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "sess-Y" }));
		appendTurns(store.db, "sess-Y", [makeTurnInput({ id: "t-0", idx: 0 })]);
		expect(listToolCallsForSession(store.db, "sess-Y")).toEqual([]);
		store.close();
	});

	it("listToolCallsForSession returns an empty array for a missing session", () => {
		const store = makeTempStore();
		expect(listToolCallsForSession(store.db, "missing")).toEqual([]);
		store.close();
	});
});
