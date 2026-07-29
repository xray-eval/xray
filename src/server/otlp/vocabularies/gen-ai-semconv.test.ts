import { genAiSemconvVocabulary } from "./gen-ai-semconv.ts";
import { EMPTY_RESOURCE, makeProjectedSpan } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("genAiSemconvVocabulary — chat / text_completion", () => {
	it("extracts model_usage from a chat span", () => {
		const span = makeProjectedSpan({
			name: "chat gpt-4o",
			startedAt: "2026-05-18T12:00:00.000Z",
			endedAt: "2026-05-18T12:00:00.250Z",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.system": "openai",
				"gen_ai.request.model": "gpt-4o-2026-05-01",
				"gen_ai.response.model": "gpt-4o-2026-05-01",
				"gen_ai.usage.input_tokens": 42,
				"gen_ai.usage.output_tokens": 7,
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("gen_ai");
		expect(out?.modelUsage).toEqual([
			{
				provider: "openai",
				model: "gpt-4o-2026-05-01",
				inputTokens: 42,
				outputTokens: 7,
				totalTokens: 49,
				ttftMs: null,
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:00.250Z",
				latencyMs: 250,
			},
		]);
	});

	it("converts gen_ai.response.time_to_first_chunk (seconds) to ttftMs", () => {
		const span = makeProjectedSpan({
			name: "chat gpt-4o",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.response.time_to_first_chunk": 0.25,
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.modelUsage?.[0]?.ttftMs).toBe(250);
	});

	it("drops a negative time_to_first_chunk to null", () => {
		const span = makeProjectedSpan({
			name: "chat gpt-4o",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.response.time_to_first_chunk": -1,
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.modelUsage?.[0]?.ttftMs).toBeNull();
	});

	it("falls back to gen_ai.request.model when response.model is absent", () => {
		const span = makeProjectedSpan({
			name: "chat gpt-4o",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.request.model": "gpt-4o-fallback",
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.modelUsage?.[0]?.model).toBe("gpt-4o-fallback");
	});

	it("recognizes a span by name-prefix when gen_ai.operation.name is absent", () => {
		const span = makeProjectedSpan({
			name: "text_completion claude-3",
			attributes: { "gen_ai.system": "anthropic" },
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("gen_ai");
		expect(out?.modelUsage).toHaveLength(1);
	});
});

describe("genAiSemconvVocabulary — execute_tool", () => {
	it("extracts a tool_call with safe-JSON args + result", () => {
		const span = makeProjectedSpan({
			name: "execute_tool lookup_user",
			startedAt: "2026-05-18T12:00:00.000Z",
			endedAt: "2026-05-18T12:00:00.050Z",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "lookup_user",
				"gen_ai.tool.arguments": '{"user_id":"u1"}',
				"gen_ai.tool.result": '{"name":"Ada"}',
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("gen_ai");
		expect(out?.toolCalls).toEqual([
			{
				name: "lookup_user",
				argsJson: '{"user_id":"u1"}',
				resultJson: '{"name":"Ada"}',
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:00.050Z",
				latencyMs: 50,
			},
		]);
	});

	it("wraps non-JSON tool args/result as JSON strings rather than dropping them", () => {
		const span = makeProjectedSpan({
			name: "execute_tool weather",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "weather",
				"gen_ai.tool.arguments": "sunny",
				"gen_ai.tool.result": "rainy",
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.toolCalls?.[0]?.argsJson).toBe('"sunny"');
		expect(out?.toolCalls?.[0]?.resultJson).toBe('"rainy"');
	});

	it("derives tool name from span name when gen_ai.tool.name is absent", () => {
		const span = makeProjectedSpan({
			name: "execute_tool from_name",
			attributes: { "gen_ai.operation.name": "execute_tool" },
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.toolCalls?.[0]?.name).toBe("from_name");
	});

	it("reads tool I/O from the semconv gen_ai.tool.call.* keys", () => {
		const span = makeProjectedSpan({
			name: "execute_tool reserve_table",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "reserve_table",
				"gen_ai.tool.call.arguments": '{"party_size":2}',
				"gen_ai.tool.call.result": '{"ok":true}',
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.toolCalls?.[0]?.argsJson).toBe('{"party_size":2}');
		expect(out?.toolCalls?.[0]?.resultJson).toBe('{"ok":true}');
	});

	it("reads tool I/O from pydantic-ai's pre-v3 tool_arguments / tool_response keys", () => {
		const span = makeProjectedSpan({
			name: "running tool",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "reserve_table",
				tool_arguments: '{"party_size":2}',
				tool_response: '{"ok":true}',
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.toolCalls).toEqual([
			{
				name: "reserve_table",
				argsJson: '{"party_size":2}',
				resultJson: '{"ok":true}',
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:01.000Z",
				latencyMs: 1000,
			},
		]);
	});

	it("keeps the non-prefixed tool I/O keys on the persisted span attributes", () => {
		const span = makeProjectedSpan({
			name: "running tool",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "reserve_table",
				tool_arguments: '{"party_size":2}',
				tool_response: '{"ok":true}',
				"logfire.msg": "running tool: reserve_table",
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.attributes).toEqual({
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "reserve_table",
			tool_arguments: '{"party_size":2}',
			tool_response: '{"ok":true}',
		});
	});

	it("prefers gen_ai.tool.arguments over the call.* and pre-v3 fallbacks", () => {
		const span = makeProjectedSpan({
			name: "execute_tool reserve_table",
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": "reserve_table",
				"gen_ai.tool.arguments": '{"src":"canonical"}',
				"gen_ai.tool.call.arguments": '{"src":"semconv"}',
				tool_arguments: '{"src":"pre_v3"}',
				"gen_ai.tool.result": '{"src":"canonical"}',
				"gen_ai.tool.call.result": '{"src":"semconv"}',
				tool_response: '{"src":"pre_v3"}',
			},
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.toolCalls?.[0]?.argsJson).toBe('{"src":"canonical"}');
		expect(out?.toolCalls?.[0]?.resultJson).toBe('{"src":"canonical"}');
	});
});

describe("genAiSemconvVocabulary — non-matching spans", () => {
	it("returns null for a span with no gen_ai attribute and no recognized name", () => {
		const span = makeProjectedSpan({
			name: "some.other.span",
			attributes: { "http.method": "POST" },
		});
		expect(genAiSemconvVocabulary(span, EMPTY_RESOURCE)).toBeNull();
	});

	it("claims a gen_ai span with an unknown operation but produces no extracted rows", () => {
		const span = makeProjectedSpan({
			name: "gen_ai.embed",
			attributes: { "gen_ai.operation.name": "embed", "gen_ai.system": "openai" },
		});
		const out = genAiSemconvVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("gen_ai");
		expect(out?.modelUsage).toBeUndefined();
		expect(out?.toolCalls).toBeUndefined();
	});
});
