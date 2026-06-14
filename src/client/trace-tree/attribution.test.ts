import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";

import { attributeSpansToTurns, spanStartSeconds } from "./attribution.ts";
import { describe, expect, it } from "bun:test";

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

function span(id: number, name: string, audioOffsetMs: number | null): SpanResponse {
	return {
		id,
		trace_id: "trace",
		span_id: `span-${id}`,
		parent_span_id: null,
		name,
		vocabulary: "xray",
		started_at: "2026-05-25T10:00:00.000Z",
		ended_at: "2026-05-25T10:00:00.000Z",
		attributes_json: "{}",
		audio_offset_ms: audioOffsetMs,
	};
}

describe("attributeSpansToTurns", () => {
	// turn_end_ms 2_500 then 6_500 → clamped windows [0,2500), [2500,6500).
	const turns: readonly ReplayTurnResponse[] = [
		turn(0, "user", 0, 2_500),
		turn(1, "agent", 2_500, 6_500),
	];

	it("places each span on its enclosing turn by audio_offset_ms", () => {
		const result = attributeSpansToTurns(turns, [
			span(1, "stt.transcribe", 500),
			span(2, "tts.synthesize", 4_000),
		]);
		expect(result.perTurn.get(0)?.map((s) => s.id)).toEqual([1]);
		expect(result.perTurn.get(1)?.map((s) => s.id)).toEqual([2]);
		expect(result.untimed).toEqual([]);
	});

	it("collects spans outside every window into untimed", () => {
		const result = attributeSpansToTurns(turns, [
			span(1, "setup", -1_000), // before the first window
			span(2, "teardown", 7_000), // after the last window
		]);
		expect(result.untimed.map((s) => s.id)).toEqual([1, 2]);
		expect(result.perTurn.get(0)).toEqual([]);
		expect(result.perTurn.get(1)).toEqual([]);
	});

	it("puts a span with a null offset (no recording anchor) into untimed", () => {
		const result = attributeSpansToTurns(turns, [span(1, "unplaceable", null)]);
		expect(result.untimed.map((s) => s.id)).toEqual([1]);
		expect(result.perTurn.get(0)).toEqual([]);
	});

	it("places a span on the exact start boundary inside that turn", () => {
		const result = attributeSpansToTurns(turns, [span(1, "boundary", 0)]);
		expect(result.perTurn.get(0)?.map((s) => s.id)).toEqual([1]);
		expect(result.untimed).toEqual([]);
	});

	it("assigns a boundary span to the LATER turn — matching the server's half-open window", () => {
		// The shared turn edge at 2500 belongs to turn 1 (half-open [2500,6500)),
		// not turn 0. This is the rule the assertion evaluator uses, so the
		// inspector groups the span under the same turn its assertion scored.
		const result = attributeSpansToTurns(turns, [span(1, "boundary", 2_500)]);
		expect(result.perTurn.get(1)?.map((s) => s.id)).toEqual([1]);
		expect(result.perTurn.get(0)).toEqual([]);
	});

	it("tiles with no gaps: a span between voice ends still lands in the later turn", () => {
		// turn_end 2500 then 6500 leaves no gap once clamped — offset 2700 is in
		// turn 1's window, never untimed.
		const result = attributeSpansToTurns(turns, [span(1, "between", 2_700)]);
		expect(result.perTurn.get(1)?.map((s) => s.id)).toEqual([1]);
		expect(result.untimed).toEqual([]);
	});

	it("returns empty buckets for each turn when no spans land", () => {
		const result = attributeSpansToTurns(turns, []);
		expect(result.perTurn.size).toBe(2);
		expect(result.perTurn.get(0)).toEqual([]);
		expect(result.perTurn.get(1)).toEqual([]);
		expect(result.untimed).toEqual([]);
	});
});

describe("spanStartSeconds", () => {
	it("converts audio_offset_ms to seconds", () => {
		expect(spanStartSeconds(span(1, "x", 3_250))).toBeCloseTo(3.25, 5);
	});

	it("preserves a negative offset (span before recording t=0)", () => {
		expect(spanStartSeconds(span(1, "x", -500))).toBeCloseTo(-0.5, 5);
	});

	it("returns null when the span has no offset", () => {
		expect(spanStartSeconds(span(1, "x", null))).toBeNull();
	});
});
