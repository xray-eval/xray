import { describe, expect, it } from "vitest";

import { turns } from "./schema.ts";
import { saveSession } from "./sessions-repo.ts";
import { makeSession, makeTempStore, makeToolCallInput, makeTurnInput } from "./test-utils.ts";
import { appendToolCalls, listToolCallsForTurn } from "./tool-calls-repo.ts";
import { appendTurns } from "./turns-repo.ts";

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
});
