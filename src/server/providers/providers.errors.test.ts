import { AmbiguousProviderConfigError, ProviderConfigError } from "./providers.errors.ts";
import { describe, expect, it } from "bun:test";

describe("AmbiguousProviderConfigError", () => {
	it("is catchable as ProviderConfigError", () => {
		const err = new AmbiguousProviderConfigError("XRAY_JUDGE_PROVIDER");
		expect(err).toBeInstanceOf(ProviderConfigError);
		expect(err).toBeInstanceOf(Error);
	});

	it("has a stable name and carries the selector env var", () => {
		const err = new AmbiguousProviderConfigError("XRAY_TRANSCRIPTION_PROVIDER");
		expect(err.name).toBe("AmbiguousProviderConfigError");
		expect(err.selectorEnvVar).toBe("XRAY_TRANSCRIPTION_PROVIDER");
		expect(err.message).toContain("XRAY_TRANSCRIPTION_PROVIDER");
		expect(err.message).toContain("OPENAI_API_KEY");
		expect(err.message).toContain("GOOGLE_API_KEY");
	});
});
