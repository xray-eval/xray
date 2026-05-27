import { redactProviderSecrets } from "./redact.ts";
import { describe, expect, it } from "bun:test";

describe("redactProviderSecrets", () => {
	it("redacts classic OpenAI sk- keys", () => {
		expect(redactProviderSecrets("auth Bearer sk-abc123XYZ_def")).toBe("auth Bearer sk-***");
	});

	it("redacts OpenAI project keys (sk-proj-...)", () => {
		expect(redactProviderSecrets("key sk-proj-AbC123_def-456")).toBe("key sk-***");
	});

	it("redacts Google AIza keys (39 chars)", () => {
		expect(
			redactProviderSecrets("API key AIzaSyA1234567890ABCDEF1234567890ABCDEFGH was invalid"),
		).toBe("API key AIza*** was invalid");
	});

	it("redacts both prefixes in the same string", () => {
		const input = "openai sk-abc123 google AIzaSyA1234567890ABCDEF1234567890ABCDEFGH";
		expect(redactProviderSecrets(input)).toBe("openai sk-*** google AIza***");
	});

	it("leaves strings without keys unchanged", () => {
		expect(redactProviderSecrets("no keys here")).toBe("no keys here");
	});

	it("does not redact AIza-like substrings shorter than the full 39-char format", () => {
		// Short AIza-prefixed string is not a real key shape — leave it alone
		// to avoid false positives in unrelated log lines.
		expect(redactProviderSecrets("AIzaShort")).toBe("AIzaShort");
	});
});
