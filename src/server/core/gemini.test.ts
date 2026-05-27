import { extractGeminiText } from "./gemini.ts";
import { describe, expect, it } from "bun:test";

// A distinct error type so tests can assert the factory is the throw path.
class FakeProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FakeProviderError";
	}
}
const makeError = (message: string): Error => new FakeProviderError(message);

function envelope(text: string, finishReason = "STOP"): unknown {
	return { candidates: [{ content: { parts: [{ text }] }, finishReason }] };
}

describe("extractGeminiText", () => {
	it("returns the joined candidate text on a valid STOP response", () => {
		expect(extractGeminiText(envelope("hello world"), makeError)).toBe("hello world");
	});

	it("joins multiple parts in order", () => {
		const raw = { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] };
		expect(extractGeminiText(raw, makeError)).toBe("ab");
	});

	it("throws via the factory when the envelope fails schema validation", () => {
		const err = (() => {
			try {
				extractGeminiText("not an object", makeError);
				return null;
			} catch (e) {
				return e;
			}
		})();
		if (!(err instanceof FakeProviderError)) {
			throw new Error(`expected FakeProviderError, got ${err}`);
		}
		expect(err.message).toContain("response failed validation");
	});

	it("throws on a promptFeedback safety block", () => {
		const raw = { promptFeedback: { blockReason: "SAFETY" } };
		expect(() => extractGeminiText(raw, makeError)).toThrow(
			"prompt blocked by safety filter: SAFETY",
		);
	});

	it("throws on an empty candidates array", () => {
		expect(() => extractGeminiText({ candidates: [] }, makeError)).toThrow(
			"response candidates array was empty",
		);
	});

	it("throws on a non-STOP finishReason (e.g. MAX_TOKENS)", () => {
		expect(() => extractGeminiText(envelope("partial", "MAX_TOKENS"), makeError)).toThrow(
			'candidate finished with reason "MAX_TOKENS" (expected STOP)',
		);
	});

	it("treats an absent finishReason as acceptable", () => {
		const raw = { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
		expect(extractGeminiText(raw, makeError)).toBe("ok");
	});

	it("throws when the candidate content is empty", () => {
		expect(() => extractGeminiText(envelope(""), makeError)).toThrow("candidate content was empty");
	});
});
