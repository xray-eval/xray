import * as v from "valibot";

import { mergeAbortSignals } from "@/server/core/abort.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { NoTtsVoiceForLanguageError, TtsProviderError } from "./tts.errors.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./tts.types.ts";

const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const DEEPGRAM_MODELS_URL = "https://api.deepgram.com/v1/models";
// Deepgram folds family + voice + language into a single voice-model id
// (`aura-2-thalia-en`). xray's provider contract splits model and voice, so
// here `model` is the family (fingerprint-stable) and `voice` carries the
// full voice-model id sent as the `model` query param on /v1/speak.
const DEFAULT_FAMILY = "aura-2";
// Deepgram's documented default voice.
const DEFAULT_VOICE = "aura-2-thalia-en";
// `encoding=linear16&container=none` returns headerless little-endian
// int16 at the requested rate (`audio/l16;rate=24000`) — no container
// parsing needed; the synthesis service resamples to 48kHz.
const DEEPGRAM_PCM_RATE = 24_000;
const DEFAULT_TIMEOUT_MS = 120_000;
// Same TTL rationale as the Mistral voice catalog: voices change rarely,
// but a new region/language rollout should be picked up without a restart.
const MODELS_CATALOG_TTL_MS = 300_000;

// /v1/models response, modeled only down to the tts voice list we read.
const TtsModelSchema = v.object({
	canonical_name: v.optional(v.string()),
	name: v.optional(v.string()),
	languages: v.optional(v.union([v.array(v.string()), v.null()])),
});
type TtsModel = v.InferOutput<typeof TtsModelSchema>;
const ModelsResponseSchema = v.object({
	tts: v.array(TtsModelSchema),
});

export interface DeepgramTtsOptions {
	readonly apiKey: () => string | undefined;
	/** Voice-model family prefix used when resolving a default voice
	 *  (`aura-2`); NOT the per-request voice id. */
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Deepgram Aura TTS provider. Requests raw PCM (headerless int16 @ 24kHz)
 * so no container parsing is needed; the synthesis service resamples to
 * 48kHz.
 *
 * Aura voices are language-specific (`aura-2-aurelia-de` speaks German,
 * `aura-2-thalia-en` English) — `resolveDefaultVoice` filters the live
 * `/v1/models` catalog by the configured family and the turn's language,
 * so a German turn gets a German voice without per-turn configuration.
 */
export function createDeepgramTtsProvider(opts: DeepgramTtsOptions): TtsProvider {
	const family = opts.model ?? DEFAULT_FAMILY;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let catalogCache: { at: number; voices: TtsModel[] } | null = null;
	let catalogInFlight: Promise<TtsModel[]> | null = null;

	async function loadCatalog(key: string): Promise<TtsModel[]> {
		if (catalogCache !== null && Date.now() - catalogCache.at < MODELS_CATALOG_TTL_MS) {
			return catalogCache.voices;
		}
		if (catalogInFlight !== null) return catalogInFlight;
		catalogInFlight = (async () => {
			let response: Response;
			try {
				response = await fetchImpl(DEEPGRAM_MODELS_URL, {
					headers: { authorization: `Token ${key}` },
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `models catalog fetch timed out after ${timeoutMs}ms`
						: "models catalog fetch failed";
				throw new TtsProviderError("deepgram", message, null, { cause });
			}
			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TtsProviderError(
					"deepgram",
					`models catalog HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}
			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TtsProviderError(
					"deepgram",
					"models catalog body was not valid JSON",
					response.status,
					{
						cause,
					},
				);
			}
			const parsed = v.safeParse(ModelsResponseSchema, raw);
			if (!parsed.success) {
				throw new TtsProviderError(
					"deepgram",
					`models catalog failed validation: ${parsed.issues.map((i) => i.message).join("; ")}`,
					response.status,
				);
			}
			catalogCache = { at: Date.now(), voices: parsed.output.tts };
			return parsed.output.tts;
		})();
		try {
			return await catalogInFlight;
		} finally {
			catalogInFlight = null;
		}
	}

	return {
		name: "deepgram",
		model: family,
		async resolveDefaultVoice(language?: string): Promise<string> {
			if (language === undefined) return DEFAULT_VOICE;
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("DEEPGRAM_API_KEY");
			}
			const voices = await loadCatalog(key);
			const match = pickVoiceForLanguage(voices, family, language.toLowerCase().replace("-", "_"));
			if (match === undefined) throw new NoTtsVoiceForLanguageError("deepgram", language);
			return match;
		},
		async synthesize(input: TtsRequest): Promise<TtsResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("DEEPGRAM_API_KEY");
			}
			const params = new URLSearchParams({
				model: input.voice,
				encoding: "linear16",
				sample_rate: String(DEEPGRAM_PCM_RATE),
				container: "none",
			});

			let response: Response;
			try {
				response = await fetchImpl(`${DEEPGRAM_SPEAK_URL}?${params}`, {
					method: "POST",
					headers: {
						authorization: `Token ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ text: input.text }),
					signal: mergeAbortSignals(input.signal, timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
						: cause instanceof Error && cause.name === "AbortError"
							? "fetch aborted by caller"
							: "fetch failed";
				throw new TtsProviderError("deepgram", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TtsProviderError(
					"deepgram",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let buffer: ArrayBuffer;
			try {
				buffer = await response.arrayBuffer();
			} catch (cause) {
				throw new TtsProviderError("deepgram", "could not read response body", response.status, {
					cause,
				});
			}
			if (buffer.byteLength === 0) {
				throw new TtsProviderError("deepgram", "response pcm body was empty", response.status);
			}
			if (buffer.byteLength % 2 !== 0) {
				throw new TtsProviderError(
					"deepgram",
					`response pcm body has odd length ${buffer.byteLength}`,
					response.status,
				);
			}
			return { pcm: new Int16Array(buffer), sampleRate: DEEPGRAM_PCM_RATE };
		},
	};
}

/**
 * Deterministic voice pick: family-prefixed voices only; exact regional
 * matches (`en_gb` → en-GB) beat primary-subtag matches, a primary-only
 * request treats every regional variant as equal; alphabetically first
 * canonical name wins within a tier.
 */
function pickVoiceForLanguage(
	voices: readonly TtsModel[],
	family: string,
	normalized: string,
): string | undefined {
	const primary = normalized.split("_")[0] ?? normalized;
	// `aura` must not swallow `aura-2-*`: a remainder starting with a digit
	// is a versioned sub-family, not a voice name.
	const inFamily = voices.filter((voice) => {
		const canonical = voice.canonical_name ?? voice.name ?? "";
		return canonical.startsWith(`${family}-`) && !/^\d/.test(canonical.slice(family.length + 1));
	});
	const tagsOf = (voice: TtsModel) =>
		(voice.languages ?? []).map((l) => l.toLowerCase().replace("-", "_"));
	const byPrimary = inFamily.filter((voice) =>
		tagsOf(voice).some((l) => (l.split("_")[0] ?? l) === primary),
	);
	const exact = normalized.includes("_")
		? inFamily.filter((voice) => tagsOf(voice).includes(normalized))
		: [];
	const pool = exact.length > 0 ? exact : byPrimary;
	const sorted = [...pool].sort((a, b) =>
		(a.canonical_name ?? a.name ?? "").localeCompare(b.canonical_name ?? b.name ?? ""),
	);
	const first = sorted[0];
	return first !== undefined ? (first.canonical_name ?? first.name) : undefined;
}
