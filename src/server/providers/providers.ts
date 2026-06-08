import { match } from "ts-pattern";

import type { Env } from "@/server/env/env.ts";
import { createGoogleGeminiJudgeProvider } from "@/server/judges/judges.google-gemini.ts";
import { createMistralJudgeProvider } from "@/server/judges/judges.mistral.ts";
import { createOpenAIJudgeProvider } from "@/server/judges/judges.openai.ts";
import type { JudgeProvider } from "@/server/judges/judges.types.ts";
import { createGoogleGeminiTranscriptionProvider } from "@/server/transcription/transcription.google-gemini.ts";
import { createMistralVoxtralProvider } from "@/server/transcription/transcription.mistral-voxtral.ts";
import { createOpenAIWhisperProvider } from "@/server/transcription/transcription.openai-whisper.ts";
import type { TranscriptionProvider } from "@/server/transcription/transcription.types.ts";
import { createGoogleGeminiTtsProvider } from "@/server/tts/tts.google-gemini.ts";
import { createMistralTtsProvider } from "@/server/tts/tts.mistral.ts";
import { createOpenAITtsProvider } from "@/server/tts/tts.openai.ts";
import type { TtsProvider } from "@/server/tts/tts.types.ts";

import { AmbiguousProviderConfigError } from "./providers.errors.ts";

export interface ProviderCandidate<K extends string> {
	readonly kind: K;
	readonly keyEnvVar: string;
	readonly hasKey: boolean;
}

/**
 * Resolve which provider kind to construct for a stage.
 *
 * Precedence:
 *   1. Explicit selector (`XRAY_*_PROVIDER`) wins.
 *   2. Otherwise infer from which API key is set. Exactly one key set →
 *      that provider. Two or more set + no selector →
 *      `AmbiguousProviderConfigError` (silent defaulting hides the
 *      operator's actual intent).
 *   3. No key set → fall back to the first candidate (OpenAI); its lazy
 *      apiKey resolver throws `MissingProviderCredentialError` on the
 *      first stage that needs a credential. Boot still succeeds so
 *      operators can run smoke flows that don't touch the LLM stages.
 */
export function resolveProviderKind<K extends string>(
	explicit: K | undefined,
	selectorEnvVar: string,
	candidates: readonly [ProviderCandidate<K>, ...ProviderCandidate<K>[]],
): K {
	if (explicit !== undefined) return explicit;
	const withKey = candidates.filter((c) => c.hasKey);
	if (withKey.length > 1) {
		throw new AmbiguousProviderConfigError(
			selectorEnvVar,
			withKey.map((c) => c.keyEnvVar),
		);
	}
	const sole = withKey[0];
	if (sole !== undefined) return sole.kind;
	return candidates[0].kind;
}

export function buildTranscriptionProvider(cfg: Env): TranscriptionProvider {
	const kind = resolveProviderKind(cfg.XRAY_TRANSCRIPTION_PROVIDER, "XRAY_TRANSCRIPTION_PROVIDER", [
		{
			kind: "openai-whisper" as const,
			keyEnvVar: "OPENAI_API_KEY",
			hasKey: cfg.OPENAI_API_KEY !== undefined,
		},
		{
			kind: "google-gemini" as const,
			keyEnvVar: "GOOGLE_API_KEY",
			hasKey: cfg.GOOGLE_API_KEY !== undefined,
		},
		{
			kind: "mistral-voxtral" as const,
			keyEnvVar: "MISTRAL_API_KEY",
			hasKey: cfg.MISTRAL_API_KEY !== undefined,
		},
	]);
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
		.with("mistral-voxtral", () =>
			createMistralVoxtralProvider({
				apiKey: () => cfg.MISTRAL_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.exhaustive();
}

export function buildTtsProvider(cfg: Env): TtsProvider {
	const kind = resolveProviderKind(cfg.XRAY_TTS_PROVIDER, "XRAY_TTS_PROVIDER", [
		{
			kind: "openai" as const,
			keyEnvVar: "OPENAI_API_KEY",
			hasKey: cfg.OPENAI_API_KEY !== undefined,
		},
		{
			kind: "google-gemini" as const,
			keyEnvVar: "GOOGLE_API_KEY",
			hasKey: cfg.GOOGLE_API_KEY !== undefined,
		},
		{
			kind: "mistral" as const,
			keyEnvVar: "MISTRAL_API_KEY",
			hasKey: cfg.MISTRAL_API_KEY !== undefined,
		},
	]);
	const modelOverride = cfg.XRAY_TTS_MODEL;
	return match(kind)
		.with("openai", () =>
			createOpenAITtsProvider({
				apiKey: () => cfg.OPENAI_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.with("google-gemini", () =>
			createGoogleGeminiTtsProvider({
				apiKey: () => cfg.GOOGLE_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.with("mistral", () =>
			createMistralTtsProvider({
				apiKey: () => cfg.MISTRAL_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.exhaustive();
}

export function buildJudgeProvider(cfg: Env): JudgeProvider {
	const kind = resolveProviderKind(cfg.XRAY_JUDGE_PROVIDER, "XRAY_JUDGE_PROVIDER", [
		{
			kind: "openai" as const,
			keyEnvVar: "OPENAI_API_KEY",
			hasKey: cfg.OPENAI_API_KEY !== undefined,
		},
		{
			kind: "google-gemini" as const,
			keyEnvVar: "GOOGLE_API_KEY",
			hasKey: cfg.GOOGLE_API_KEY !== undefined,
		},
		{
			kind: "mistral" as const,
			keyEnvVar: "MISTRAL_API_KEY",
			hasKey: cfg.MISTRAL_API_KEY !== undefined,
		},
	]);
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
		.with("mistral", () =>
			createMistralJudgeProvider({
				apiKey: () => cfg.MISTRAL_API_KEY,
				...(modelOverride !== undefined ? { model: modelOverride } : {}),
			}),
		)
		.exhaustive();
}
