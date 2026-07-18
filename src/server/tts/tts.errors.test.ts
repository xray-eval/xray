import { NoTtsVoiceForLanguageError, TtsError, TtsProviderError } from "./tts.errors.ts";
import { describe, expect, it } from "bun:test";

describe("TtsProviderError", () => {
	it("is catchable as TtsError", () => {
		const err = new TtsProviderError("openai", "boom", 500);
		expect(err).toBeInstanceOf(TtsError);
		expect(err).toBeInstanceOf(Error);
	});

	it("has a stable name and carries provider + statusCode", () => {
		const err = new TtsProviderError("mistral", "rate limited", 429);
		expect(err.name).toBe("TtsProviderError");
		expect(err.provider).toBe("mistral");
		expect(err.statusCode).toBe(429);
		expect(err.message).toContain("mistral");
	});

	it("defaults statusCode to null", () => {
		expect(new TtsProviderError("google-gemini", "fetch failed").statusCode).toBeNull();
	});
});

describe("NoTtsVoiceForLanguageError", () => {
	it("is catchable as TtsError", () => {
		const err = new NoTtsVoiceForLanguageError("mistral", "ja");
		expect(err).toBeInstanceOf(TtsError);
		expect(err).toBeInstanceOf(Error);
	});

	it("has a stable name and carries provider + language", () => {
		const err = new NoTtsVoiceForLanguageError("deepgram", "ko");
		expect(err.name).toBe("NoTtsVoiceForLanguageError");
		expect(err.provider).toBe("deepgram");
		expect(err.language).toBe("ko");
		expect(err.message).toContain('"ko"');
	});
});
