import { describe, expect, it } from "vitest";

import { saveSession } from "./sessions-repo.ts";
import { makeSession, makeTempStore, makeTurnInput } from "./test-utils.ts";
import { appendTurns, listTurnsForSession } from "./turns-repo.ts";

describe("turns-repo", () => {
	it("appends and lists turns in idx order", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "sess-1" }));
		appendTurns(store.db, "sess-1", [
			makeTurnInput({ id: "t-2", idx: 1, text: "second" }),
			makeTurnInput({ id: "t-1", idx: 0, text: "first" }),
		]);
		const rows = listTurnsForSession(store.db, "sess-1");
		expect(rows.map((r) => r.text)).toEqual(["first", "second"]);
		expect(rows.every((r) => r.sessionId === "sess-1")).toBe(true);
		store.close();
	});

	it("preserves nullable optional fields", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "sess-1" }));
		appendTurns(store.db, "sess-1", [
			makeTurnInput({
				id: "t-1",
				idx: 0,
				activeNodeId: "node-A",
				edgeFiredId: "edge-1",
				edgeReasoning: "matched intent",
				promptSeen: "system prompt",
				llmLatencyMs: 1234,
			}),
		]);
		const [row] = listTurnsForSession(store.db, "sess-1");
		expect(row).toMatchObject({
			activeNodeId: "node-A",
			edgeFiredId: "edge-1",
			edgeReasoning: "matched intent",
			promptSeen: "system prompt",
			llmLatencyMs: 1234,
		});
		store.close();
	});

	it("no-ops on empty input", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "sess-1" }));
		expect(() => appendTurns(store.db, "sess-1", [])).not.toThrow();
		expect(listTurnsForSession(store.db, "sess-1")).toEqual([]);
		store.close();
	});

	it("rolls back the whole batch on UNIQUE(session_id, idx) collision", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "sess-1" }));
		appendTurns(store.db, "sess-1", [makeTurnInput({ id: "t-0", idx: 0 })]);

		expect(() =>
			appendTurns(store.db, "sess-1", [
				makeTurnInput({ id: "t-1", idx: 1 }),
				// collides with the existing idx=0 row above — whole batch rolls back.
				makeTurnInput({ id: "t-2", idx: 0 }),
			]),
		).toThrow();

		// t-1 must NOT be present even though its insert succeeded individually:
		// the transaction wrapper rolls back partial work on any failure.
		const ids = listTurnsForSession(store.db, "sess-1").map((r) => r.id);
		expect(ids).toEqual(["t-0"]);
		store.close();
	});

	it("rejects turns whose session does not exist (FK)", () => {
		const store = makeTempStore();
		expect(() =>
			appendTurns(store.db, "missing-sess", [makeTurnInput({ id: "t-1", idx: 0 })]),
		).toThrow();
		store.close();
	});
});
