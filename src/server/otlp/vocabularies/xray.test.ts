import { EMPTY_RESOURCE, makeProjectedSpan } from "./test-utils.ts";
import { xrayVocabulary } from "./xray.ts";
import { describe, expect, it } from "bun:test";

describe("xrayVocabulary — recognized span shapes", () => {
	it("claims xray.assertion as a raw xray span (no extracted rows in v0.2)", () => {
		const span = makeProjectedSpan({
			name: "xray.assertion",
			endedAt: "2026-05-18T12:00:02.500Z",
			attributes: {
				"xray.turn.idx": 1,
				"xray.assertion.name": "agent_greets",
				"xray.assertion.status": "passed",
				"xray.assertion.message": "ok",
			},
		});
		const out = xrayVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("xray");
		expect(out?.toolCalls).toBeUndefined();
		expect(out?.modelUsage).toBeUndefined();
	});

	it("claims xray.judge as a raw xray span (no extracted rows in v0.2)", () => {
		const span = makeProjectedSpan({
			name: "xray.judge",
			attributes: {
				"xray.judge.status": "failed",
				"xray.judge.score": 3,
				"xray.judge.reason": "off-topic",
			},
		});
		const out = xrayVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("xray");
	});

	it("claims xray.turn as a raw xray span (no extracted rows in v0.2)", () => {
		const span = makeProjectedSpan({
			name: "xray.turn",
			startedAt: "2026-05-18T12:00:00.000Z",
			endedAt: "2026-05-18T12:00:03.000Z",
			attributes: {
				"xray.turn.idx": 2,
				"xray.turn.role": "agent",
			},
		});
		const out = xrayVocabulary(span, EMPTY_RESOURCE);
		expect(out?.vocabulary).toBe("xray");
	});

	it("claims xray.stage.stt / xray.stage.tts as raw xray spans", () => {
		const stt = xrayVocabulary(makeProjectedSpan({ name: "xray.stage.stt" }), EMPTY_RESOURCE);
		const tts = xrayVocabulary(makeProjectedSpan({ name: "xray.stage.tts" }), EMPTY_RESOURCE);
		expect(stt?.vocabulary).toBe("xray");
		expect(tts?.vocabulary).toBe("xray");
	});

	it("narrows the attribute bag to xray.* keys only", () => {
		const span = makeProjectedSpan({
			name: "xray.assertion",
			attributes: {
				"xray.turn.idx": 0,
				"xray.assertion.name": "n",
				"xray.assertion.status": "passed",
				"gen_ai.system": "openai",
				"http.method": "POST",
			},
		});
		const out = xrayVocabulary(span, EMPTY_RESOURCE);
		expect(out?.attributes).toEqual({
			"xray.turn.idx": 0,
			"xray.assertion.name": "n",
			"xray.assertion.status": "passed",
		});
	});
});

describe("xrayVocabulary — non-matching spans", () => {
	it("returns null for a span whose name is not in the recognized set", () => {
		const span = makeProjectedSpan({
			name: "some.other.span",
			attributes: { "xray.turn.idx": 0 },
		});
		expect(xrayVocabulary(span, EMPTY_RESOURCE)).toBeNull();
	});

	it("returns null for a gen_ai-only span", () => {
		const span = makeProjectedSpan({
			name: "chat gpt-4o",
			attributes: { "gen_ai.operation.name": "chat" },
		});
		expect(xrayVocabulary(span, EMPTY_RESOURCE)).toBeNull();
	});
});
