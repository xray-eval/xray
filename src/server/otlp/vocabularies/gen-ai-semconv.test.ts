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
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:00.250Z",
				latencyMs: 250,
			},
		]);
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
