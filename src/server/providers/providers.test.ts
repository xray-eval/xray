import { makeEnv } from "@/server/env/test-utils.ts";

import { AmbiguousProviderConfigError } from "./providers.errors.ts";
import {
	buildJudgeProvider,
	buildTranscriptionProvider,
	resolveProviderKind,
} from "./providers.ts";
import { describe, expect, it } from "bun:test";

describe("resolveProviderKind", () => {
	it("returns the explicit selector regardless of which keys are set", () => {
		const kind = resolveProviderKind(
			"google",
			"XRAY_JUDGE_PROVIDER",
			true,
			true,
			"openai",
			"google",
		);
		expect(kind).toBe("google");
	});

	it("throws AmbiguousProviderConfigError when both keys are set and no selector is given", () => {
		const err = (() => {
			try {
				resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", true, true, "openai", "google");
				return null;
			} catch (e) {
				return e;
			}
		})();
		if (!(err instanceof AmbiguousProviderConfigError)) {
			throw new Error(`expected AmbiguousProviderConfigError, got ${err}`);
		}
		expect(err.selectorEnvVar).toBe("XRAY_JUDGE_PROVIDER");
	});

	it("infers the Google kind when only the Google key is set", () => {
		expect(
			resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", false, true, "openai", "google"),
		).toBe("google");
	});

	it("infers the OpenAI kind when only the OpenAI key is set", () => {
		expect(
			resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", true, false, "openai", "google"),
		).toBe("openai");
	});

	it("falls back to the OpenAI kind when neither key is set", () => {
		expect(
			resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", false, false, "openai", "google"),
		).toBe("openai");
	});
});

describe("buildTranscriptionProvider", () => {
	it("builds the Whisper provider when only OPENAI_API_KEY is set", () => {
		const p = buildTranscriptionProvider(makeEnv({ OPENAI_API_KEY: "sk-x" }));
		expect(p.name).toBe("openai-whisper");
		expect(p.model).toBe("whisper-1");
	});

	it("builds the Gemini provider when only GOOGLE_API_KEY is set", () => {
		const p = buildTranscriptionProvider(makeEnv({ GOOGLE_API_KEY: "AIza-x" }));
		expect(p.name).toBe("google-gemini");
		expect(p.model).toBe("gemini-2.5-flash");
	});

	it("honors the explicit selector over key inference", () => {
		const p = buildTranscriptionProvider(
			makeEnv({ OPENAI_API_KEY: "sk-x", XRAY_TRANSCRIPTION_PROVIDER: "google-gemini" }),
		);
		expect(p.name).toBe("google-gemini");
	});

	it("applies XRAY_TRANSCRIPTION_MODEL as the model override", () => {
		const p = buildTranscriptionProvider(
			makeEnv({ GOOGLE_API_KEY: "AIza-x", XRAY_TRANSCRIPTION_MODEL: "gemini-2.5-pro" }),
		);
		expect(p.model).toBe("gemini-2.5-pro");
	});

	it("throws when both keys are set and no selector is given", () => {
		expect(() =>
			buildTranscriptionProvider(makeEnv({ OPENAI_API_KEY: "sk-x", GOOGLE_API_KEY: "AIza-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});
});

describe("buildJudgeProvider", () => {
	it("builds the OpenAI judge when only OPENAI_API_KEY is set", () => {
		const p = buildJudgeProvider(makeEnv({ OPENAI_API_KEY: "sk-x" }));
		expect(p.name).toBe("openai");
		expect(p.model).toBe("gpt-4o-2024-08-06");
	});

	it("builds the Gemini judge when only GOOGLE_API_KEY is set", () => {
		const p = buildJudgeProvider(makeEnv({ GOOGLE_API_KEY: "AIza-x" }));
		expect(p.name).toBe("google-gemini");
		expect(p.model).toBe("gemini-3.5-flash");
	});

	it("applies XRAY_JUDGE_MODEL as the model override", () => {
		const p = buildJudgeProvider(
			makeEnv({ GOOGLE_API_KEY: "AIza-x", XRAY_JUDGE_MODEL: "gemini-2.5-flash" }),
		);
		expect(p.model).toBe("gemini-2.5-flash");
	});

	it("throws when both keys are set and no selector is given", () => {
		expect(() =>
			buildJudgeProvider(makeEnv({ OPENAI_API_KEY: "sk-x", GOOGLE_API_KEY: "AIza-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});
});
