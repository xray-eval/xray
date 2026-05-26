import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";

import { buildTree } from "./build-tree.ts";
import { describe, expect, it } from "bun:test";

const REPLAY_START = "2026-05-25T10:00:00.000Z";
const REPLAY_START_MS = Date.parse(REPLAY_START);

function turn(
	idx: number,
	role: "user" | "agent",
	startMs: number,
	endMs: number,
): ReplayTurnResponse {
	return {
		idx,
		role,
		turn_start_ms: startMs,
		turn_end_ms: endMs,
		voice_start_ms: startMs,
		voice_end_ms: endMs,
	};
}

function span(
	id: number,
	name: string,
	offsetStartMs: number,
	offsetEndMs: number,
	parentSpanId: string | null = null,
): SpanResponse {
	return {
		id,
		trace_id: "trace",
		span_id: `s-${id}`,
		parent_span_id: parentSpanId,
		name,
		vocabulary: "xray",
		started_at: new Date(REPLAY_START_MS + offsetStartMs).toISOString(),
		ended_at: new Date(REPLAY_START_MS + offsetEndMs).toISOString(),
		attributes_json: "{}",
	};
}

describe("buildTree", () => {
	it("emits one row per turn in idx order", () => {
		const { rows } = buildTree(
			[turn(0, "user", 0, 2_500), turn(1, "agent", 3_000, 6_500)],
			[],
			REPLAY_START,
		);
		const turnRows = rows.filter((r) => r.kind === "turn");
		expect(turnRows.map((r) => r.kind === "turn" && r.idx)).toEqual([0, 1]);
	});

	it("indents spans under their attributed turn at depth 1", () => {
		const { rows } = buildTree(
			[turn(0, "user", 0, 2_500)],
			[span(1, "stt.transcribe", 200, 1_400)],
			REPLAY_START,
		);
		const spanRows = rows.filter((r) => r.kind === "span");
		expect(spanRows).toHaveLength(1);
		const [s] = spanRows;
		expect(s?.kind === "span" && s.depth).toBe(1);
	});

	it("indents nested spans by parent_span_id at depth 2+", () => {
		const { rows } = buildTree(
			[turn(0, "user", 0, 2_500)],
			[
				span(1, "tool_call", 200, 1_400),
				span(2, "rag_retrieve", 300, 800, "s-1"),
				span(3, "openai_embed", 320, 700, "s-2"),
			],
			REPLAY_START,
		);
		const depthByName = new Map(
			rows
				.filter((r) => r.kind === "span")
				.map((r) => (r.kind === "span" ? [r.name, r.depth] : ["", 0])),
		);
		expect(depthByName.get("tool_call")).toBe(1);
		expect(depthByName.get("rag_retrieve")).toBe(2);
		expect(depthByName.get("openai_embed")).toBe(3);
	});

	it("emits children in pre-order (parent immediately before its first child)", () => {
		const { rows } = buildTree(
			[turn(0, "user", 0, 2_500)],
			[span(1, "tool_call", 200, 1_400), span(2, "rag_retrieve", 300, 800, "s-1")],
			REPLAY_START,
		);
		const names = rows.map((r) =>
			r.kind === "span" ? r.name : r.kind === "turn" ? `turn-${r.idx}` : r.id,
		);
		expect(names).toEqual(["turn-0", "tool_call", "rag_retrieve"]);
	});

	it("appends an untimed-group row at the end when spans miss every turn", () => {
		const { rows } = buildTree(
			[turn(0, "user", 0, 2_500)],
			[span(1, "setup", -1_000, -500)],
			REPLAY_START,
		);
		expect(rows[rows.length - 2]?.kind).toBe("untimed-group");
		expect(rows[rows.length - 1]?.kind).toBe("span");
	});

	it("scale.startSec ≤ 0 and scale.endSec covers the latest span", () => {
		const { scale } = buildTree(
			[turn(0, "user", 0, 2_500)],
			[span(1, "setup", -500, -100), span(2, "stt", 200, 1_400)],
			REPLAY_START,
		);
		expect(scale.startSec).toBeLessThanOrEqual(-0.5);
		expect(scale.endSec).toBeGreaterThanOrEqual(2.5);
		expect(scale.durationSec).toBeGreaterThan(0);
	});

	it("surfaces cyclically-parented spans at the root depth instead of dropping them", () => {
		// A.parent = B and B.parent = A — neither span has a reachable root.
		// The DFS would never visit them, so the cycle rescue must promote
		// them to the turn's root depth.
		const a = span(1, "a", 200, 400);
		const b = span(2, "b", 300, 500);
		const cyclicA: typeof a = { ...a, parent_span_id: "s-2" };
		const cyclicB: typeof b = { ...b, parent_span_id: "s-1" };
		const { rows } = buildTree([turn(0, "user", 0, 2_500)], [cyclicA, cyclicB], REPLAY_START);
		const spanRows = rows.filter((r) => r.kind === "span");
		expect(spanRows.map((r) => r.kind === "span" && r.name).sort()).toEqual(["a", "b"]);
		for (const r of spanRows) {
			if (r.kind === "span") expect(r.depth).toBe(1);
		}
	});

	it("marks turn rows as hasChildren=true only when spans attach", () => {
		const { rows } = buildTree(
			[turn(0, "user", 0, 2_500), turn(1, "agent", 3_000, 6_500)],
			[span(1, "stt", 100, 1_000)],
			REPLAY_START,
		);
		const turnRows = rows.filter((r) => r.kind === "turn");
		expect(turnRows[0]?.kind === "turn" && turnRows[0].hasChildren).toBe(true);
		expect(turnRows[1]?.kind === "turn" && turnRows[1].hasChildren).toBe(false);
	});
});
