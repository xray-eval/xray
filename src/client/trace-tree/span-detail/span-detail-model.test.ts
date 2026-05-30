import type { ModelUsageResponse, SpanResponse, ToolCallResponse } from "@/client/api/api.types.ts";

import {
	offsetSec,
	parseSpanAttributes,
	resolveSpanDetail,
	spanDurationMs,
} from "./span-detail-model.ts";
import { describe, expect, it } from "bun:test";

const REPLAY_START = "2026-05-25T10:00:00.000Z";

function span(overrides: Partial<SpanResponse> = {}): SpanResponse {
	return {
		id: 1,
		trace_id: "trace-1",
		span_id: "span-1",
		parent_span_id: null,
		name: "agent_turn",
		vocabulary: "gen_ai",
		started_at: "2026-05-25T10:00:00.000Z",
		ended_at: "2026-05-25T10:00:04.300Z",
		attributes_json: "{}",
		...overrides,
	};
}

function usage(spanId: string | null): ModelUsageResponse {
	return {
		id: 1,
		turn_idx: 0,
		span_id: spanId,
		provider: "Gemini",
		model: "gemini-3.1-flash-live-preview",
		input_tokens: 1222,
		output_tokens: 111,
		total_tokens: 1333,
		started_at: null,
		ended_at: null,
		latency_ms: 4302,
	};
}

function toolCall(spanId: string | null): ToolCallResponse {
	return {
		id: 1,
		turn_idx: 0,
		span_id: spanId,
		name: "get_current_year",
		args_json: "{}",
		result_json: '{"year":2026}',
		started_at: null,
		ended_at: null,
		latency_ms: 0,
	};
}

describe("spanDurationMs", () => {
	it("computes the millisecond gap between two ISO timestamps", () => {
		expect(spanDurationMs("2026-05-25T10:00:00.000Z", "2026-05-25T10:00:04.300Z")).toBe(4300);
	});

	it("clamps a negative (end-before-start) duration to 0", () => {
		expect(spanDurationMs("2026-05-25T10:00:04.000Z", "2026-05-25T10:00:00.000Z")).toBe(0);
	});

	it("returns 0 for unparseable timestamps", () => {
		expect(spanDurationMs("not-a-date", "also-not")).toBe(0);
	});
});

describe("offsetSec", () => {
	it("returns seconds elapsed since replay start", () => {
		expect(offsetSec("2026-05-25T10:00:04.300Z", REPLAY_START)).toBe(4.3);
	});

	it("returns 0 for unparseable input", () => {
		expect(offsetSec("nope", REPLAY_START)).toBe(0);
	});
});

describe("parseSpanAttributes", () => {
	it("splits each key into namespace + leaf and sorts by key", () => {
		const result = parseSpanAttributes(
			'{"gen_ai.usage.input_tokens":1222,"gen_ai.operation.name":"chat"}',
		);
		expect(result.kind).toBe("parsed");
		if (result.kind !== "parsed") throw new Error("expected parsed");
		expect(result.entries.map((e) => e.key)).toEqual([
			"gen_ai.operation.name",
			"gen_ai.usage.input_tokens",
		]);
		expect(result.entries[0]).toMatchObject({
			namespace: "gen_ai",
			leaf: "operation.name",
			value: "chat",
		});
		expect(result.entries[1]?.value).toBe(1222);
	});

	it("treats a key with no dot as a bare leaf with empty namespace", () => {
		const result = parseSpanAttributes('{"modality":"voice"}');
		if (result.kind !== "parsed") throw new Error("expected parsed");
		expect(result.entries[0]).toMatchObject({ namespace: "", leaf: "modality", value: "voice" });
	});

	it("returns an empty parsed bag for {}", () => {
		expect(parseSpanAttributes("{}")).toEqual({ kind: "parsed", entries: [] });
	});

	it("preserves nested container values as-is", () => {
		const result = parseSpanAttributes('{"x":{"a":1},"y":[1,2]}');
		if (result.kind !== "parsed") throw new Error("expected parsed");
		expect(result.entries.find((e) => e.key === "x")?.value).toEqual({ a: 1 });
		expect(result.entries.find((e) => e.key === "y")?.value).toEqual([1, 2]);
	});

	it("falls back to raw for malformed JSON", () => {
		expect(parseSpanAttributes("{nope")).toEqual({ kind: "raw", raw: "{nope" });
	});

	it("falls back to raw when the top level is an array or scalar", () => {
		expect(parseSpanAttributes("[1,2]")).toEqual({ kind: "raw", raw: "[1,2]" });
		expect(parseSpanAttributes("42")).toEqual({ kind: "raw", raw: "42" });
	});
});

describe("resolveSpanDetail", () => {
	const source = {
		replayStartIso: REPLAY_START,
		spans: [
			span({ span_id: "parent", name: "agent_turn" }),
			span({
				id: 2,
				span_id: "child",
				parent_span_id: "parent",
				name: "execute_tool",
				vocabulary: "gen_ai",
				attributes_json: '{"gen_ai.tool.name":"get_current_year"}',
			}),
		],
		modelUsage: [usage("parent"), usage("other")],
		toolCalls: [toolCall("child"), toolCall("other")],
	};

	it("returns null for a null selection", () => {
		expect(resolveSpanDetail(null, source)).toBeNull();
	});

	it("returns null when no span matches the id", () => {
		expect(resolveSpanDetail("missing", source)).toBeNull();
	});

	it("links only the model_usage rows that share the span_id", () => {
		const detail = resolveSpanDetail("parent", source);
		expect(detail?.usage).toHaveLength(1);
		expect(detail?.toolCalls).toHaveLength(0);
		expect(detail?.durationMs).toBe(4300);
		expect(detail?.startOffsetSec).toBe(0);
		expect(detail?.endOffsetSec).toBe(4.3);
	});

	it("links only the tool_calls that share the span_id and resolves the parent name", () => {
		const detail = resolveSpanDetail("child", source);
		expect(detail?.toolCalls).toHaveLength(1);
		expect(detail?.usage).toHaveLength(0);
		expect(detail?.parentName).toBe("agent_turn");
		expect(detail?.attributes.kind).toBe("parsed");
	});

	it("leaves parentName null when the parent span isn't in the replay", () => {
		const detail = resolveSpanDetail("parent", source);
		expect(detail?.parentName).toBeNull();
	});
});
