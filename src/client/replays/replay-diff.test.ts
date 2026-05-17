import { makeConversationTurn } from "@/server/sessions/sessions.test-utils.ts";

import { alignTurns, turnsDiffer } from "./replay-diff.tsx";
import { describe, expect, it } from "bun:test";

describe("alignTurns", () => {
	it("pairs turns at the same idx as 'same' when they match", () => {
		const t0 = makeConversationTurn({ id: "s-0", idx: 0, text: "hi" });
		const t0p = makeConversationTurn({ id: "t-0", idx: 0, text: "hi" });
		expect(alignTurns([t0], [t0p])).toEqual([{ idx: 0, source: t0, target: t0p, kind: "same" }]);
	});

	it("marks pairs that differ in any tracked field as 'diff'", () => {
		const src = makeConversationTurn({ idx: 0, text: "hi" });
		const tgt = makeConversationTurn({ idx: 0, text: "hello" });
		const [pair] = alignTurns([src], [tgt]);
		expect(pair?.kind).toBe("diff");
	});

	it("marks one-sided positions as 'missing'", () => {
		const src = makeConversationTurn({ idx: 0 });
		expect(alignTurns([src], []).map((p) => p.kind)).toEqual(["missing"]);
		expect(alignTurns([], [src]).map((p) => p.kind)).toEqual(["missing"]);
	});

	it("preserves both sides on a missing pair", () => {
		const src = makeConversationTurn({ idx: 5, text: "only in source" });
		const [pair] = alignTurns([src], []);
		expect(pair?.source).toEqual(src);
		expect(pair?.target).toBeUndefined();
	});

	it("returns pairs sorted by idx regardless of input order", () => {
		const turns = [2, 0, 1].map((idx) => makeConversationTurn({ idx }));
		expect(alignTurns(turns, []).map((p) => p.idx)).toEqual([0, 1, 2]);
	});

	it("includes indices present in only one side", () => {
		const src = makeConversationTurn({ idx: 0 });
		const tgt = makeConversationTurn({ idx: 1 });
		expect(alignTurns([src], [tgt]).map((p) => p.idx)).toEqual([0, 1]);
	});
});

describe("turnsDiffer", () => {
	it("returns false for two structurally identical turns", () => {
		const a = makeConversationTurn();
		const b = makeConversationTurn();
		expect(turnsDiffer(a, b)).toBe(false);
	});

	it("returns true on differing role", () => {
		const a = makeConversationTurn({ role: "user" });
		const b = makeConversationTurn({ role: "agent" });
		expect(turnsDiffer(a, b)).toBe(true);
	});

	it("returns true on differing text", () => {
		const a = makeConversationTurn({ text: "hi" });
		const b = makeConversationTurn({ text: "hello" });
		expect(turnsDiffer(a, b)).toBe(true);
	});

	it("ignores responseLatencyMs differences — replay vs source latency would flood the diff with false positives", () => {
		const a = makeConversationTurn({ responseLatencyMs: 100 });
		const b = makeConversationTurn({ responseLatencyMs: 200 });
		expect(turnsDiffer(a, b)).toBe(false);
	});

	it("returns true on differing interrupted", () => {
		const a = makeConversationTurn({ interrupted: true });
		const b = makeConversationTurn({ interrupted: false });
		expect(turnsDiffer(a, b)).toBe(true);
	});

	it("returns true when tool call counts differ", () => {
		const a = makeConversationTurn({
			toolCalls: [{ idx: 0, name: "f", args: {}, result: null, latencyMs: null }],
		});
		const b = makeConversationTurn({ toolCalls: [] });
		expect(turnsDiffer(a, b)).toBe(true);
	});

	it("returns true when tool call names differ at the same position", () => {
		const a = makeConversationTurn({
			toolCalls: [{ idx: 0, name: "f", args: {}, result: null, latencyMs: null }],
		});
		const b = makeConversationTurn({
			toolCalls: [{ idx: 0, name: "g", args: {}, result: null, latencyMs: null }],
		});
		expect(turnsDiffer(a, b)).toBe(true);
	});

	it("returns true when tool call args differ", () => {
		const a = makeConversationTurn({
			toolCalls: [{ idx: 0, name: "f", args: { x: 1 }, result: null, latencyMs: null }],
		});
		const b = makeConversationTurn({
			toolCalls: [{ idx: 0, name: "f", args: { x: 2 }, result: null, latencyMs: null }],
		});
		expect(turnsDiffer(a, b)).toBe(true);
	});
});
