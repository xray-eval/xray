import { makeEnv } from "@/server/env/test-utils.ts";

import { AmbiguousProviderConfigError } from "./providers.errors.ts";
import {
	buildJudgeProvider,
	buildTranscriptionProvider,
	buildTtsProvider,
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

	const singleKeyCases: readonly (readonly [TestKind, ReturnType<typeof candidates>])[] = [
		["google", candidates({ google: true })],
		["mistral", candidates({ mistral: true })],
		["openai", candidates({ openai: true })],
	];
	it.each(singleKeyCases)("infers %s when its key is the only one set", (kind, only) => {
		expect(resolveProviderKind(undefined, "XRAY_JUDGE_PROVIDER", only)).toBe(kind);
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
		expect(p.model).toBe("voxtral-small-2507");
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

	it("ignores AWS_BEARER_TOKEN_BEDROCK (judge-only) and falls back to Whisper", () => {
		const p = buildTranscriptionProvider(makeEnv({ AWS_BEARER_TOKEN_BEDROCK: "bk-x" }));
		expect(p.name).toBe("openai-whisper");
	});

	it("builds the Deepgram provider when only DEEPGRAM_API_KEY is set", () => {
		const p = buildTranscriptionProvider(makeEnv({ DEEPGRAM_API_KEY: "dg-x" }));
		expect(p.name).toBe("deepgram-nova");
		expect(p.model).toBe("nova-3");
	});

	it("honors the explicit deepgram-nova selector over key inference", () => {
		const p = buildTranscriptionProvider(
			makeEnv({ OPENAI_API_KEY: "sk-x", XRAY_TRANSCRIPTION_PROVIDER: "deepgram-nova" }),
		);
		expect(p.name).toBe("deepgram-nova");
	});

	it("applies XRAY_TRANSCRIPTION_MODEL as the Deepgram model override", () => {
		const p = buildTranscriptionProvider(
			makeEnv({ DEEPGRAM_API_KEY: "dg-x", XRAY_TRANSCRIPTION_MODEL: "nova-2" }),
		);
		expect(p.model).toBe("nova-2");
	});

	it("throws when the Deepgram key and another key are set with no selector", () => {
		expect(() =>
			buildTranscriptionProvider(makeEnv({ OPENAI_API_KEY: "sk-x", DEEPGRAM_API_KEY: "dg-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});

	it("throws when two keys are set and no selector is given", () => {
		expect(() =>
			buildTranscriptionProvider(makeEnv({ OPENAI_API_KEY: "sk-x", MISTRAL_API_KEY: "mk-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});
});

describe("buildTtsProvider", () => {
	it("builds the OpenAI TTS provider when only OPENAI_API_KEY is set", async () => {
		const p = buildTtsProvider(makeEnv({ OPENAI_API_KEY: "sk-x" }));
		expect(p.name).toBe("openai");
		expect(p.model).toBe("gpt-4o-mini-tts");
		expect(await p.resolveDefaultVoice()).toBe("alloy");
	});

	it("builds the Gemini TTS provider when only GOOGLE_API_KEY is set", () => {
		const p = buildTtsProvider(makeEnv({ GOOGLE_API_KEY: "AIza-x" }));
		expect(p.name).toBe("google-gemini");
		expect(p.model).toBe("gemini-2.5-flash-preview-tts");
	});

	it("builds the Mistral TTS provider when only MISTRAL_API_KEY is set", async () => {
		const p = buildTtsProvider(makeEnv({ MISTRAL_API_KEY: "mk-x" }));
		expect(p.name).toBe("mistral");
		expect(p.model).toBe("voxtral-mini-tts-2603");
		expect(await p.resolveDefaultVoice()).toBe("en_paul_neutral");
	});

	it("honors the explicit selector over key inference", () => {
		const p = buildTtsProvider(makeEnv({ OPENAI_API_KEY: "sk-x", XRAY_TTS_PROVIDER: "mistral" }));
		expect(p.name).toBe("mistral");
	});

	it("applies XRAY_TTS_MODEL as the model override", () => {
		const p = buildTtsProvider(makeEnv({ MISTRAL_API_KEY: "mk-x", XRAY_TTS_MODEL: "tts-next" }));
		expect(p.model).toBe("tts-next");
	});

	it("throws when two keys are set and no selector is given", () => {
		expect(() =>
			buildTtsProvider(makeEnv({ OPENAI_API_KEY: "sk-x", GOOGLE_API_KEY: "AIza-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});

	it("ignores AWS_BEARER_TOKEN_BEDROCK (no Bedrock TTS) and falls back to OpenAI", () => {
		const p = buildTtsProvider(makeEnv({ AWS_BEARER_TOKEN_BEDROCK: "bk-x" }));
		expect(p.name).toBe("openai");
	});

	it("builds the Deepgram TTS provider when only DEEPGRAM_API_KEY is set", async () => {
		const p = buildTtsProvider(makeEnv({ DEEPGRAM_API_KEY: "dg-x" }));
		expect(p.name).toBe("deepgram");
		expect(p.model).toBe("aura-2");
		expect(await p.resolveDefaultVoice()).toBe("aura-2-thalia-en");
	});

	it("honors the explicit deepgram TTS selector over key inference", () => {
		const p = buildTtsProvider(makeEnv({ OPENAI_API_KEY: "sk-x", XRAY_TTS_PROVIDER: "deepgram" }));
		expect(p.name).toBe("deepgram");
	});

	it("throws when the Deepgram key and another key are set with no TTS selector", () => {
		expect(() =>
			buildTtsProvider(makeEnv({ MISTRAL_API_KEY: "mk-x", DEEPGRAM_API_KEY: "dg-x" })),
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

	it("builds the Bedrock judge when only AWS_BEARER_TOKEN_BEDROCK is set", () => {
		const p = buildJudgeProvider(makeEnv({ AWS_BEARER_TOKEN_BEDROCK: "bk-x" }));
		expect(p.name).toBe("bedrock");
		expect(p.model).toBe("global.anthropic.claude-opus-4-8");
	});

	it("honors the explicit bedrock selector over key inference", () => {
		const p = buildJudgeProvider(
			makeEnv({ OPENAI_API_KEY: "sk-x", XRAY_JUDGE_PROVIDER: "bedrock" }),
		);
		expect(p.name).toBe("bedrock");
	});

	it("applies XRAY_JUDGE_MODEL as the Bedrock model override", () => {
		const p = buildJudgeProvider(
			makeEnv({ AWS_BEARER_TOKEN_BEDROCK: "bk-x", XRAY_JUDGE_MODEL: "us.amazon.nova-2-pro-v1:0" }),
		);
		expect(p.model).toBe("us.amazon.nova-2-pro-v1:0");
	});

	it("builds the Bedrock judge from SigV4 access keys when explicitly selected", () => {
		const p = buildJudgeProvider(
			makeEnv({
				AWS_ACCESS_KEY_ID: "AKID",
				AWS_SECRET_ACCESS_KEY: "secret",
				XRAY_JUDGE_PROVIDER: "bedrock",
			}),
		);
		expect(p.name).toBe("bedrock");
	});

	it("does NOT auto-infer the Bedrock judge from ambient AWS access keys", () => {
		// AWS_ACCESS_KEY_ID / SECRET are commonly present for unrelated AWS
		// access; with an actual judge key set and no selector, only that key's
		// provider is inferred — the AWS creds must not create ambiguity.
		const p = buildJudgeProvider(
			makeEnv({
				OPENAI_API_KEY: "sk-x",
				AWS_ACCESS_KEY_ID: "AKID",
				AWS_SECRET_ACCESS_KEY: "secret",
			}),
		);
		expect(p.name).toBe("openai");
	});

	it("throws when the Bedrock token and another key are set with no selector", () => {
		expect(() =>
			buildJudgeProvider(makeEnv({ MISTRAL_API_KEY: "mk-x", AWS_BEARER_TOKEN_BEDROCK: "bk-x" })),
		).toThrow(AmbiguousProviderConfigError);
	});
});
