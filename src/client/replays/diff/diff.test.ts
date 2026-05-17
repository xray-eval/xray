import { makeConversation, makeConversationTurn } from "@/server/sessions/sessions.test-utils.ts";

import {
	alignTurns,
	compareToolCalls,
	diffTurn,
	divergencesFor,
	plural,
	summarize,
	summarySentence,
} from "./diff.ts";
import { describe, expect, it } from "bun:test";

describe("alignTurns", () => {
	it("pairs turns at the same idx", () => {
		const s = makeConversationTurn({ id: "s-0", idx: 0, text: "hi" });
		const t = makeConversationTurn({ id: "t-0", idx: 0, text: "hi" });
		expect(alignTurns([s], [t])).toEqual([{ idx: 0, source: s, target: t }]);
	});

	it("preserves both sides on a missing pair", () => {
		const s = makeConversationTurn({ idx: 5, text: "only in source" });
		const [pair] = alignTurns([s], []);
		expect(pair?.source).toEqual(s);
		expect(pair?.target).toBeUndefined();
	});

	it("returns pairs sorted by idx regardless of input order", () => {
		const turns = [2, 0, 1].map((idx) => makeConversationTurn({ idx }));
		expect(alignTurns(turns, []).map((p) => p.idx)).toEqual([0, 1, 2]);
	});

	it("includes indices present in only one side", () => {
		const s = makeConversationTurn({ idx: 0 });
		const t = makeConversationTurn({ idx: 1 });
		expect(alignTurns([s], [t]).map((p) => p.idx)).toEqual([0, 1]);
	});
});

describe("compareToolCalls", () => {
	const call = (idx: number, name: string, args: unknown = {}) => ({
		idx,
		name,
		args,
		result: null,
		latencyMs: null,
	});

	it("returns empty annotations for empty inputs", () => {
		expect(compareToolCalls([], [])).toEqual({ sourceAnnotated: [], targetAnnotated: [] });
	});

	it("marks exact matches as 'matched' on both sides", () => {
		const a = call(0, "f", { x: 1 });
		const b = call(0, "f", { x: 1 });
		const { sourceAnnotated, targetAnnotated } = compareToolCalls([a], [b]);
		expect(sourceAnnotated[0]?.status).toBe("matched");
		expect(targetAnnotated[0]?.status).toBe("matched");
	});

	it("marks same name, different args as 'args-differ'", () => {
		const a = call(0, "f", { x: 1 });
		const b = call(0, "f", { x: 2 });
		const { sourceAnnotated, targetAnnotated } = compareToolCalls([a], [b]);
		expect(sourceAnnotated[0]?.status).toBe("args-differ");
		expect(targetAnnotated[0]?.status).toBe("args-differ");
	});

	it("marks source-only calls as 'only-this-side'", () => {
		const { sourceAnnotated, targetAnnotated } = compareToolCalls([call(0, "f")], []);
		expect(sourceAnnotated[0]?.status).toBe("only-this-side");
		expect(targetAnnotated).toEqual([]);
	});

	it("marks target-only calls as 'only-this-side'", () => {
		const { sourceAnnotated, targetAnnotated } = compareToolCalls([], [call(0, "f")]);
		expect(sourceAnnotated).toEqual([]);
		expect(targetAnnotated[0]?.status).toBe("only-this-side");
	});

	it("handles duplicate-name greedy matching", () => {
		// Source [f(1), f(2)] vs target [f(2)]: exact pass matches index-1 source
		// to target. Name pass has nothing to do on target. Source[0] stays only.
		const { sourceAnnotated, targetAnnotated } = compareToolCalls(
			[call(0, "f", { x: 1 }), call(1, "f", { x: 2 })],
			[call(0, "f", { x: 2 })],
		);
		expect(sourceAnnotated[0]?.status).toBe("only-this-side");
		expect(sourceAnnotated[1]?.status).toBe("matched");
		expect(targetAnnotated[0]?.status).toBe("matched");
	});
});

describe("diffTurn", () => {
	it("returns no divergence for identical turns", () => {
		const a = makeConversationTurn();
		const b = makeConversationTurn();
		const d = diffTurn(a, b);
		expect(d.toolsDiverge).toBe(false);
		expect(d.latencyRegressed).toBe(false);
		expect(d.shapeDiverged).toBe(false);
	});

	it("does NOT flag text-only differences (text always varies, that's expected)", () => {
		const a = makeConversationTurn({ text: "hi there" });
		const b = makeConversationTurn({ text: "hello, how can I help?" });
		const d = diffTurn(a, b);
		expect(d.toolsDiverge).toBe(false);
		expect(d.shapeDiverged).toBe(false);
		expect(d.latencyRegressed).toBe(false);
	});

	it("flags tool call divergence when tools only present in source", () => {
		const a = makeConversationTurn({
			toolCalls: [{ idx: 0, name: "f", args: {}, result: null, latencyMs: null }],
		});
		const b = makeConversationTurn({ toolCalls: [] });
		expect(diffTurn(a, b).toolsDiverge).toBe(true);
	});

	it("flags latencyRegressed when target >= 2x slower AND >= 100ms delta", () => {
		const a = makeConversationTurn({ role: "agent", responseLatencyMs: 200 });
		const b = makeConversationTurn({ role: "agent", responseLatencyMs: 500 });
		expect(diffTurn(a, b).latencyRegressed).toBe(true);
	});

	it("does NOT flag latencyRegressed when delta < 100ms (noise gate)", () => {
		// 3x slower but only 60ms more — within noise on small numbers.
		const a = makeConversationTurn({ role: "agent", responseLatencyMs: 30 });
		const b = makeConversationTurn({ role: "agent", responseLatencyMs: 90 });
		expect(diffTurn(a, b).latencyRegressed).toBe(false);
	});

	it("does NOT flag latencyRegressed when delta < 2x (multiplier gate)", () => {
		// 200ms slower in absolute, but only 1.5x — within wall-clock variance.
		const a = makeConversationTurn({ role: "agent", responseLatencyMs: 400 });
		const b = makeConversationTurn({ role: "agent", responseLatencyMs: 600 });
		expect(diffTurn(a, b).latencyRegressed).toBe(false);
	});

	it("does NOT flag latencyRegressed for non-agent turns", () => {
		const a = makeConversationTurn({ role: "user", responseLatencyMs: 100 });
		const b = makeConversationTurn({ role: "user", responseLatencyMs: 1000 });
		expect(diffTurn(a, b).latencyRegressed).toBe(false);
	});

	it("flags shapeDiverged when roles differ", () => {
		const a = makeConversationTurn({ role: "user" });
		const b = makeConversationTurn({ role: "agent" });
		expect(diffTurn(a, b).shapeDiverged).toBe(true);
	});

	it("flags shapeDiverged when interrupted state differs", () => {
		const a = makeConversationTurn({ interrupted: true });
		const b = makeConversationTurn({ interrupted: false });
		expect(diffTurn(a, b).shapeDiverged).toBe(true);
	});

	it("does NOT flag shapeDiverged on missing turn (alignment handles that)", () => {
		const a = makeConversationTurn();
		expect(diffTurn(a, undefined).shapeDiverged).toBe(false);
		expect(diffTurn(undefined, a).shapeDiverged).toBe(false);
	});
});

describe("summarize", () => {
	const conv = (turns: ReturnType<typeof makeConversationTurn>[]) => makeConversation({ turns });

	it("returns all zeros and an ok sentence for identical conversations", () => {
		const t = makeConversationTurn({ idx: 0 });
		const aligned = alignTurns([t], [t]);
		const s = summarize(divergencesFor(aligned), conv([t]), conv([t]));
		expect(s.turnsWithToolDivergence).toBe(0);
		expect(s.missingToolsInReplay).toBe(0);
		expect(s.extraToolsInReplay).toBe(0);
		expect(s.latencyRegressions).toBe(0);
		expect(s.shapeDivergences).toBe(0);
		expect(summarySentence(s).tone).toBe("ok");
	});

	it("counts missing tools in replay", () => {
		const src = makeConversationTurn({
			idx: 0,
			toolCalls: [{ idx: 0, name: "lookup", args: {}, result: null, latencyMs: null }],
		});
		const tgt = makeConversationTurn({ idx: 0, toolCalls: [] });
		const aligned = alignTurns([src], [tgt]);
		const s = summarize(divergencesFor(aligned), conv([src]), conv([tgt]));
		expect(s.missingToolsInReplay).toBe(1);
		expect(s.turnsWithToolDivergence).toBe(1);
		expect(summarySentence(s)).toEqual({
			tone: "warn",
			text: "1 tool call missing in replay",
		});
	});

	it("counts latency regressions across multiple turns", () => {
		const a = makeConversationTurn({ idx: 0, role: "agent", responseLatencyMs: 100 });
		const b = makeConversationTurn({ idx: 0, role: "agent", responseLatencyMs: 800 });
		const aligned = alignTurns([a], [b]);
		expect(summarize(divergencesFor(aligned), conv([a]), conv([b])).latencyRegressions).toBe(1);
	});

	it("reports turn delta in the sentence when source/target turn counts differ", () => {
		const a = makeConversationTurn({ idx: 0 });
		const b1 = makeConversationTurn({ idx: 0 });
		const b2 = makeConversationTurn({ idx: 1 });
		const aligned = alignTurns([a], [b1, b2]);
		const s = summarize(divergencesFor(aligned), conv([a]), conv([b1, b2]));
		expect(summarySentence(s).text).toContain("1 extra turn in replay");
	});
});

describe("plural", () => {
	it("singularizes 1", () => {
		expect(plural(1, "thing")).toBe("1 thing");
	});
	it("pluralizes other counts", () => {
		expect(plural(0, "thing")).toBe("0 things");
		expect(plural(2, "thing")).toBe("2 things");
	});
});
