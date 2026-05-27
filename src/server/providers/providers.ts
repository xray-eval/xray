import { match } from "ts-pattern";

import type { Env } from "@/server/env/env.ts";
import { createGoogleGeminiJudgeProvider } from "@/server/judges/judges.google-gemini.ts";
import { createOpenAIJudgeProvider } from "@/server/judges/judges.openai.ts";
import type { JudgeProvider } from "@/server/judges/judges.types.ts";
import { createGoogleGeminiTranscriptionProvider } from "@/server/transcription/transcription.google-gemini.ts";
import { createOpenAIWhisperProvider } from "@/server/transcription/transcription.openai-whisper.ts";
import type { TranscriptionProvider } from "@/server/transcription/transcription.types.ts";

import { AmbiguousProviderConfigError } from "./providers.errors.ts";

/**
 * Resolve which provider kind to construct for a stage.
 *
 * Precedence:
 *   1. Explicit selector (`XRAY_*_PROVIDER`) wins.
 *   2. Otherwise infer from which API key is set. Exactly one key set →
 *      that provider. Both set + no selector → `AmbiguousProviderConfigError`
 *      (silent defaulting hides the operator's actual intent).
 *   3. Neither key set → fall back to the OpenAI kind; the lazy apiKey
 *      resolver throws `MissingProviderCredentialError("OPENAI_API_KEY")`
 *      on the first stage that needs a credential. Boot still succeeds so
 *      operators can run smoke flows that don't touch the LLM stages.
 */
export function resolveProviderKind<K extends string>(
	explicit: K | undefined,
	selectorEnvVar: string,
	hasOpenAI: boolean,
	hasGoogle: boolean,
	openAIKind: K,
	googleKind: K,
): K {
	if (explicit !== undefined) return explicit;
	if (hasOpenAI && hasGoogle) {
		throw new AmbiguousProviderConfigError(selectorEnvVar);
	}
	if (hasGoogle) return googleKind;
	return openAIKind;
}

export function buildTranscriptionProvider(cfg: Env): TranscriptionProvider {
	const kind = resolveProviderKind(
		cfg.XRAY_TRANSCRIPTION_PROVIDER,
		"XRAY_TRANSCRIPTION_PROVIDER",
		cfg.OPENAI_API_KEY !== undefined,
		cfg.GOOGLE_API_KEY !== undefined,
		"openai-whisper" as const,
		"google-gemini" as const,
	);
	const modelOverride = cfg.XRAY_TRANSCRIPTION_MODEL;
	return match(kind)
		.with("openai-whisper", () =>
			createOpenAIWhisperProvider({
				apiKey: () => cfg.OPENAI_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.with("google-gemini", () =>
			createGoogleGeminiTranscriptionProvider({
				apiKey: () => cfg.GOOGLE_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.exhaustive();
}

export function buildJudgeProvider(cfg: Env): JudgeProvider {
	const kind = resolveProviderKind(
		cfg.XRAY_JUDGE_PROVIDER,
		"XRAY_JUDGE_PROVIDER",
		cfg.OPENAI_API_KEY !== undefined,
		cfg.GOOGLE_API_KEY !== undefined,
		"openai" as const,
		"google-gemini" as const,
	);
	const modelOverride = cfg.XRAY_JUDGE_MODEL;
	return match(kind)
		.with("openai", () =>
			createOpenAIJudgeProvider({
				apiKey: () => cfg.OPENAI_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.with("google-gemini", () =>
			createGoogleGeminiJudgeProvider({
				apiKey: () => cfg.GOOGLE_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.exhaustive();
}
