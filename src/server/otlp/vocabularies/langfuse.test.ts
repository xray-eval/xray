import { langfuseVocabulary } from "./langfuse.ts";
import { EMPTY_RESOURCE, makeProjectedSpan } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("langfuseVocabulary — generation observations", () => {
	it("extracts model_usage from a generation observation", () => {
		const span = makeProjectedSpan({
			name: "openai-chat",
			startedAt: "2026-05-18T12:00:00.000Z",
			endedAt: "2026-05-18T12:00:00.400Z",
			attributes: {
				"langfuse.observation.type": "generation",
				"langfuse.observation.provider": "openai",
				"langfuse.observation.model.name": "gpt-4o",
				"langfuse.observation.usage_details.input": 100,
				"langfuse.observation.usage_details.output": 25,
				"langfuse.observation.usage_details.total": 125,
			},
		});
		const out = langfuseVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("langfuse");
		expect(out?.modelUsage).toEqual([
			{
				provider: "openai",
				model: "gpt-4o",
				inputTokens: 100,
				outputTokens: 25,
				totalTokens: 125,
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:00.400Z",
				latencyMs: 400,
			},
		]);
	});

	it("narrows the attribute bag to langfuse.* keys only", () => {
		const span = makeProjectedSpan({
			attributes: {
				"langfuse.observation.type": "generation",
				"langfuse.observation.model.name": "gpt",
				"http.method": "POST",
			},
		});
		const out = langfuseVocabulary(span, EMPTY_RESOURCE);
		expect(out?.attributes).toEqual({
			"langfuse.observation.type": "generation",
			"langfuse.observation.model.name": "gpt",
		});
	});
});

describe("langfuseVocabulary — tool observations", () => {
	it("extracts a tool_call from a tool observation", () => {
		const span = makeProjectedSpan({
			name: "tool-span",
			startedAt: "2026-05-18T12:00:00.000Z",
			endedAt: "2026-05-18T12:00:00.030Z",
			attributes: {
				"langfuse.observation.type": "tool",
				"langfuse.observation.name": "search",
				"langfuse.observation.input.value": '{"q":"x"}',
				"langfuse.observation.output.value": '{"hits":[]}',
			},
		});
		const out = langfuseVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("langfuse");
		expect(out?.toolCalls).toEqual([
			{
				name: "search",
				argsJson: '{"q":"x"}',
				resultJson: '{"hits":[]}',
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:00.030Z",
				latencyMs: 30,
			},
		]);
	});

	it("falls back to the span name when langfuse.observation.name is absent", () => {
		const span = makeProjectedSpan({
			name: "fallback-tool",
			attributes: { "langfuse.observation.type": "tool" },
		});
		const out = langfuseVocabulary(span, EMPTY_RESOURCE);
		expect(out?.toolCalls?.[0]?.name).toBe("fallback-tool");
	});

	it("honors the legacy langfuse.type alias", () => {
		const span = makeProjectedSpan({
			name: "legacy-gen",
			attributes: {
				"langfuse.type": "generation",
				"langfuse.observation.model.name": "gpt",
			},
		});
		const out = langfuseVocabulary(span, EMPTY_RESOURCE);
		expect(out?.modelUsage).toHaveLength(1);
		expect(out?.modelUsage?.[0]?.model).toBe("gpt");
	});
});

describe("langfuseVocabulary — non-matching spans", () => {
	it("returns null for a span with no langfuse.* attribute", () => {
		const span = makeProjectedSpan({
			name: "chat gpt",
			attributes: { "gen_ai.system": "openai" },
		});
		expect(langfuseVocabulary(span, EMPTY_RESOURCE)).toBeNull();
	});

	it("claims a langfuse span with an unrecognized observation type but emits no extracted rows", () => {
		const span = makeProjectedSpan({
			attributes: { "langfuse.observation.type": "event" },
		});
		const out = langfuseVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("langfuse");
		expect(out?.modelUsage).toBeUndefined();
		expect(out?.toolCalls).toBeUndefined();
	});
});
