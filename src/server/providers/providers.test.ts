import { makeEnv } from "@/server/env/test-utils.ts";

import { AmbiguousProviderConfigError } from "./providers.errors.ts";
import {
	buildJudgeProvider,
	buildTranscriptionProvider,
	resolveProviderKind,
} from "./providers.ts";
import { describe, expect, it } from "bun:test";

type TestKind = "openai" | "google" | "mistral";

function candidates(
	keys: Partial<Record<TestKind, boolean>>,
): readonly [
	{ kind: TestKind; keyEnvVar: string; hasKey: boolean },
	...{ kind: TestKind; keyEnvVar: string; hasKey: boolean }[],
] {
	return [
		{ kind: "openai", keyEnvVar: "OPENAI_API_KEY", hasKey: keys.openai ?? false },
		{ kind: "google", keyEnvVar: "GOOGLE_API_KEY", hasKey: keys.google ?? false },
		{ kind: "mistral", keyEnvVar: "MISTRAL_API_KEY", hasKey: keys.mistral ?? false },
	];
}

describe("resolveProviderKind", () => {
	it("returns the explicit selector regardless of which keys are set", () => {
		const kind = resolveProviderKind(
			"google",
			"XRAY_JUDGE_PROVIDER",
			candidates({ openai: true, google: true, mistral: true }),
		);
		expect(kind).toBe("google");
	});

	it("throws AmbiguousProviderConfigError listing the set keys when two keys are set and no selector is given", () => {
		const err = (() => {
			try {
				resolveProviderKind(
					undefined,
					"XRAY_JUDGE_PROVIDER",
					candidates({ openai: true, mistral: true }),
				);
				return null;
			} catch (e) {
				return e;
			}
		})();
		if (!(err instanceof AmbiguousProviderConfigError)) {
			throw new Error(`expected AmbiguousProviderConfigError, got ${err}`);
		}
		expect(err.selectorEnvVar).toBe("XRAY_JUDGE_PROVIDER");
		expect(err.setKeyEnvVars).toEqual(["OPENAI_API_KEY", "MISTRAL_API_KEY"]);
	});

	it("throws AmbiguousProviderConfigError when all three keys are set and no selector is given", () => {
		expect(() =>
			resolveProviderKind(
				undefined,
				"XRAY_JUDGE_PROVIDER",
				candidates({ openai: true, google: true, mistral: true }),
			),
		).toThrow(AmbiguousProviderConfigError);
	});

	it("infers the kind whose key is the only one set", () => {
		expect(
			resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", candidates({ google: true })),
		).toBe("google");
		expect(
			resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", candidates({ mistral: true })),
		).toBe("mistral");
		expect(
			resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", candidates({ openai: true })),
		).toBe("openai");
	});

	it("falls back to the first candidate when no key is set", () => {
		expect(resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", candidates({}))).toBe("openai");
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

	it("builds the Voxtral provider when only MISTRAL_API_KEY is set", () => {
		const p = buildTranscriptionProvider(makeEnv({ MISTRAL_API_KEY: "mk-x" }));
		expect(p.name).toBe("mistral-voxtral");
		expect(p.model).toBe("voxtral-mini-2602");
	});

	it("honors the explicit selector over key inference", () => {
		const p = buildTranscriptionProvider(
			makeEnv({ OPENAI_API_KEY: "sk-x", XRAY_TRANSCRIPTION_PROVIDER: "mistral-voxtral" }),
		);
		expect(p.name).toBe("mistral-voxtral");
	});

	it("applies XRAY_TRANSCRIPTION_MODEL as the model override", () => {
		const p = buildTranscriptionProvider(
			makeEnv({ MISTRAL_API_KEY: "mk-x", XRAY_TRANSCRIPTION_MODEL: "voxtral-small-2507" }),
		);
		expect(p.model).toBe("voxtral-small-2507");
	});

	it("throws when two keys are set and no selector is given", () => {
		expect(() =>
			buildTranscriptionProvider(makeEnv({ OPENAI_API_KEY: "sk-x", MISTRAL_API_KEY: "mk-x" })),
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

	it("builds the Mistral judge when only MISTRAL_API_KEY is set", () => {
		const p = buildJudgeProvider(makeEnv({ MISTRAL_API_KEY: "mk-x" }));
		expect(p.name).toBe("mistral");
		expect(p.model).toBe("mistral-medium-2604");
	});

	it("honors the explicit selector over key inference", () => {
		const p = buildJudgeProvider(
			makeEnv({ GOOGLE_API_KEY: "AIza-x", XRAY_JUDGE_PROVIDER: "mistral" }),
		);
		expect(p.name).toBe("mistral");
	});

	it("applies XRAY_JUDGE_MODEL as the model override", () => {
		const p = buildJudgeProvider(
			makeEnv({ MISTRAL_API_KEY: "mk-x", XRAY_JUDGE_MODEL: "mistral-large-2512" }),
		);
		expect(p.model).toBe("mistral-large-2512");
	});

	it("throws when two keys are set and no selector is given", () => {
		expect(() =>
			buildJudgeProvider(makeEnv({ GOOGLE_API_KEY: "AIza-x", MISTRAL_API_KEY: "mk-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});
});
