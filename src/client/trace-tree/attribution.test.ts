import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";

import { attributeSpansToTurns, toReplaySeconds } from "./attribution.ts";
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

function span(id: number, name: string, offsetFromReplayStartMs: number): SpanResponse {
	const started = new Date(REPLAY_START_MS + offsetFromReplayStartMs).toISOString();
	return {
		id,
		trace_id: "trace",
		span_id: `span-${id}`,
		parent_span_id: null,
		name,
		vocabulary: "xray",
		started_at: started,
		ended_at: started,
		attributes_json: "{}",
	};
}

describe("attributeSpansToTurns", () => {
	const turns: readonly ReplayTurnResponse[] = [
		turn(0, "user", 0, 2_500),
		turn(1, "agent", 3_000, 6_500),
	];

	it("places each span on its enclosing turn", () => {
		const result = attributeSpansToTurns(
			turns,
			[span(1, "stt.transcribe", 500), span(2, "tts.synthesize", 4_000)],
			REPLAY_START,
		);
		expect(result.perTurn.get(0)?.map((s) => s.id)).toEqual([1]);
		expect(result.perTurn.get(1)?.map((s) => s.id)).toEqual([2]);
		expect(result.untimed).toEqual([]);
	});

	it("collects spans outside any turn into untimed", () => {
		const result = attributeSpansToTurns(
			turns,
			[span(1, "setup", -1_000), span(2, "teardown", 7_000)],
			REPLAY_START,
		);
		expect(result.untimed.map((s) => s.id)).toEqual([1, 2]);
		expect(result.perTurn.get(0)).toEqual([]);
		expect(result.perTurn.get(1)).toEqual([]);
	});

	it("places a span on the exact start boundary inside that turn", () => {
		const result = attributeSpansToTurns(turns, [span(1, "boundary", 0)], REPLAY_START);
		expect(result.perTurn.get(0)?.map((s) => s.id)).toEqual([1]);
		expect(result.untimed).toEqual([]);
	});

	it("places a span on the exact end boundary inside that turn", () => {
		const result = attributeSpansToTurns(turns, [span(1, "boundary", 2_500)], REPLAY_START);
		expect(result.perTurn.get(0)?.map((s) => s.id)).toEqual([1]);
	});

	it("falls into untimed when a span sits in the gap between turns", () => {
		const result = attributeSpansToTurns(turns, [span(1, "gap", 2_700)], REPLAY_START);
		expect(result.untimed.map((s) => s.id)).toEqual([1]);
	});

	it("returns empty buckets for each turn when no spans land", () => {
		const result = attributeSpansToTurns(turns, [], REPLAY_START);
		expect(result.perTurn.size).toBe(2);
		expect(result.perTurn.get(0)).toEqual([]);
		expect(result.perTurn.get(1)).toEqual([]);
		expect(result.untimed).toEqual([]);
	});
});

describe("toReplaySeconds", () => {
	it("subtracts the replay start and converts to seconds", () => {
		const result = toReplaySeconds(new Date(REPLAY_START_MS + 3_250).toISOString(), REPLAY_START);
		expect(result).toBeCloseTo(3.25, 5);
	});

	it("returns negative seconds for events before replay start", () => {
		const result = toReplaySeconds(new Date(REPLAY_START_MS - 500).toISOString(), REPLAY_START);
		expect(result).toBeCloseTo(-0.5, 5);
	});
});
