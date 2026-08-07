import { genAiSemconvVocabulary } from "./gen-ai-semconv.ts";
import { langfuseVocabulary } from "./langfuse.ts";
import { SPAN_VOCABULARIES } from "./registry.ts";
import { EMPTY_RESOURCE, makeProjectedSpan } from "./test-utils.ts";
import { xrayVocabulary } from "./xray.ts";
import { describe, expect, it } from "bun:test";

/**
 * Mirrors `recognize()` in otlp.service.ts — first matcher to return
 * non-null claims the span. Duplicated rather than exported from the
 * service so this file tests the registry's ordering alone, without
 * dragging a Store in.
 */
function firstMatch(span: ReturnType<typeof makeProjectedSpan>) {
	for (const matcher of SPAN_VOCABULARIES) {
		const result = matcher(span, EMPTY_RESOURCE);
		if (result !== null) return result;
	}
	return null;
}

describe("SPAN_VOCABULARIES — declared order", () => {
	it("is xray, then gen_ai semconv, then langfuse", () => {
		expect(SPAN_VOCABULARIES).toEqual([xrayVocabulary, genAiSemconvVocabulary, langfuseVocabulary]);
	});
});

describe("SPAN_VOCABULARIES — first match wins", () => {
	it("gives xray a span that gen_ai would also claim", () => {
		// `xray.turn` is in the xray name allowlist; the `gen_ai.*`
		// attribute alone is enough for genAiSemconvVocabulary to match.
		const span = makeProjectedSpan({
			name: "xray.turn",
			attributes: {
				"xray.turn.idx": 0,
				"gen_ai.system": "openai",
				"gen_ai.operation.name": "chat",
			},
		});
		expect(genAiSemconvVocabulary(span, EMPTY_RESOURCE)?.vocabulary).toBe("gen_ai");
		expect(firstMatch(span)?.vocabulary).toBe("xray");
		// The xray matcher narrows to `xray.*`, so the losing vocabulary's
		// attributes are not carried along.
		expect(firstMatch(span)?.attributes).toEqual({ "xray.turn.idx": 0 });
		// No model_usage row is extracted — gen_ai never got to run.
		expect(firstMatch(span)?.modelUsage).toBeUndefined();
	});

	it("gives xray a span that langfuse would also claim", () => {
		const span = makeProjectedSpan({
			name: "xray.stage.tts",
			attributes: { "xray.modality": "audio", "langfuse.observation.type": "generation" },
		});
		expect(langfuseVocabulary(span, EMPTY_RESOURCE)?.vocabulary).toBe("langfuse");
		expect(firstMatch(span)?.vocabulary).toBe("xray");
	});

	it("gives gen_ai a span that langfuse would also claim", () => {
		const span = makeProjectedSpan({
			name: "chat gpt-4o",
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.system": "openai",
				"langfuse.observation.type": "generation",
				"langfuse.observation.provider": "anthropic",
			},
		});
		expect(langfuseVocabulary(span, EMPTY_RESOURCE)?.vocabulary).toBe("langfuse");
		const claimed = firstMatch(span);
		expect(claimed?.vocabulary).toBe("gen_ai");
		// One extraction, from the winner: provider is gen_ai's `openai`,
		// not langfuse's `anthropic`.
		expect(claimed?.modelUsage).toHaveLength(1);
		expect(claimed?.modelUsage?.[0]?.provider).toBe("openai");
	});

	it("falls through to langfuse when no earlier vocabulary matches", () => {
		const span = makeProjectedSpan({
			name: "anthropic-call",
			attributes: {
				"langfuse.observation.type": "generation",
				"langfuse.observation.provider": "anthropic",
			},
		});
		expect(xrayVocabulary(span, EMPTY_RESOURCE)).toBeNull();
		expect(genAiSemconvVocabulary(span, EMPTY_RESOURCE)).toBeNull();
		expect(firstMatch(span)?.vocabulary).toBe("langfuse");
	});

	it("returns null when no vocabulary claims the span", () => {
		expect(
			firstMatch(makeProjectedSpan({ name: "random.span", attributes: { foo: "bar" } })),
		).toBeNull();
	});
});
