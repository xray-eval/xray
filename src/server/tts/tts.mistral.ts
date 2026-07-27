import * as v from "valibot";

import { InvalidWavFormatError } from "@/server/audio/audio.errors.ts";
import { readMonoWav } from "@/server/audio/audio.wav.ts";
import { mergeAbortSignals } from "@/server/core/abort.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { NoTtsVoiceForLanguageError, TtsProviderError } from "./tts.errors.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./tts.types.ts";

const MISTRAL_SPEECH_URL = "https://api.mistral.ai/v1/audio/speech";
const MISTRAL_VOICES_URL = "https://api.mistral.ai/v1/audio/voices";
// Pinned dated snapshot — same drift rationale as the voxtral STT default.
const DEFAULT_MODEL = "voxtral-mini-tts-2603";
// Preset slug from Mistral's voice catalog (`GET /v1/audio/voices`). The
// API has no implicit default: requests without a voice_id are rejected
// with "Either ref_audio or voice must be provided."
const DEFAULT_VOICE = "en_paul_neutral";
const DEFAULT_TIMEOUT_MS = 120_000;

// Mistral voices are language-specific (an en_us preset speaking German is
// accented English, not German). Built-in presets exist only for these
// languages (verified against the live catalog, 2026-07-18); every other
// language resolves through the org's voice catalog, where cloned voices
// carry a `languages` tag.
const PRESET_VOICES: Readonly<Record<string, string>> = {
	en: "en_paul_neutral",
	en_us: "en_paul_neutral",
	en_gb: "gb_oliver_neutral",
	fr: "fr_marie_neutral",
	fr_fr: "fr_marie_neutral",
};
// The catalog rarely changes (voices are cloned once, reused for months) —
// a short TTL keeps a freshly-cloned voice usable without a server restart
// while capping lookups to one refresh per window.
const VOICE_CATALOG_TTL_MS = 300_000;
const VOICE_CATALOG_PAGE_LIMIT = 100;
// Backstop against a lying `total` — 1000 voices is far beyond any real org.
const VOICE_CATALOG_MAX_PAGES = 10;

// `limit`/`offset` are the working pagination params (the documented
// `page`/`page_size` pair is echoed in responses but ignored on requests —
// verified against the live API).
const VoiceCatalogItemSchema = v.object({
	id: v.string(),
	slug: v.optional(v.union([v.string(), v.null()])),
	languages: v.optional(v.union([v.array(v.string()), v.null()])),
	created_at: v.optional(v.union([v.string(), v.null()])),
});
type VoiceCatalogItem = v.InferOutput<typeof VoiceCatalogItemSchema>;
const VoiceCatalogPageSchema = v.object({
	items: v.array(VoiceCatalogItemSchema),
	total: v.optional(v.number()),
});

// `response_format: "wav"` wraps the audio as base64 inside a JSON
// envelope (verified against the live API; the raw-bytes alternative
// `"pcm"` is float32 LE, which would need a manual float→int16 pass and
// carries no self-describing sample rate).
const SpeechResponseSchema = v.object({
	audio_data: v.string(),
});

export interface MistralTtsOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Mistral Voxtral TTS provider. Decodes the base64 WAV envelope and returns
 * pcm at the WAV's declared rate (24kHz as of voxtral-mini-tts). Voice defaults
 * are language-aware — see `resolveDefaultVoice`.
 */
export function createMistralTtsProvider(opts: MistralTtsOptions): TtsProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let catalogCache: { at: number; items: VoiceCatalogItem[] } | null = null;
	let catalogInFlight: Promise<VoiceCatalogItem[]> | null = null;

	async function fetchCatalogPage(
		key: string,
		offset: number,
	): Promise<{
		items: VoiceCatalogItem[];
		total: number | undefined;
	}> {
		const url = `${MISTRAL_VOICES_URL}?limit=${VOICE_CATALOG_PAGE_LIMIT}&offset=${offset}`;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				headers: { authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (cause) {
			const message =
				cause instanceof Error && cause.name === "TimeoutError"
					? `voice catalog fetch timed out after ${timeoutMs}ms`
					: "voice catalog fetch failed";
			throw new TtsProviderError("mistral", message, null, { cause });
		}
		if (!response.ok) {
			let detail = "";
			try {
				detail = await response.text();
			} catch {
				detail = "<unreadable body>";
			}
			throw new TtsProviderError(
				"mistral",
				`voice catalog HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
				response.status,
			);
		}
		let raw: unknown;
		try {
			raw = await response.json();
		} catch (cause) {
			throw new TtsProviderError(
				"mistral",
				"voice catalog body was not valid JSON",
				response.status,
				{
					cause,
				},
			);
		}
		const parsed = v.safeParse(VoiceCatalogPageSchema, raw);
		if (!parsed.success) {
			throw new TtsProviderError(
				"mistral",
				`voice catalog failed validation: ${parsed.issues.map((i) => i.message).join("; ")}`,
				response.status,
			);
		}
		return { items: parsed.output.items, total: parsed.output.total };
	}

	async function loadCatalog(key: string): Promise<VoiceCatalogItem[]> {
		if (catalogCache !== null && Date.now() - catalogCache.at < VOICE_CATALOG_TTL_MS) {
			return catalogCache.items;
		}
		if (catalogInFlight !== null) return catalogInFlight;
		catalogInFlight = (async () => {
			const items: VoiceCatalogItem[] = [];
			for (let page = 0; page < VOICE_CATALOG_MAX_PAGES; page++) {
				const { items: pageItems, total } = await fetchCatalogPage(key, items.length);
				items.push(...pageItems);
				if (pageItems.length === 0 || total === undefined || items.length >= total) break;
			}
			catalogCache = { at: Date.now(), items };
			return items;
		})();
		try {
			return await catalogInFlight;
		} finally {
			catalogInFlight = null;
		}
	}

	return {
		name: "mistral",
		model,
		async resolveDefaultVoice(language?: string): Promise<string> {
			if (language === undefined) return DEFAULT_VOICE;
			const normalized = language.toLowerCase().replace("-", "_");
			const preset = PRESET_VOICES[normalized];
			if (preset !== undefined) return preset;
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("MISTRAL_API_KEY");
			}
			const items = await loadCatalog(key);
			const match = pickVoiceForLanguage(items, normalized);
			if (match === undefined) throw new NoTtsVoiceForLanguageError("mistral", language);
			return match;
		},
		async synthesize(input: TtsRequest): Promise<TtsResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("MISTRAL_API_KEY");
			}
			const body = {
				model,
				input: input.text,
				voice_id: input.voice,
				response_format: "wav" as const,
			};

			let response: Response;
			try {
				response = await fetchImpl(MISTRAL_SPEECH_URL, {
					method: "POST",
					headers: {
						authorization: `Bearer ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal: mergeAbortSignals(input.signal, timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
						: cause instanceof Error && cause.name === "AbortError"
							? "fetch aborted by caller"
							: "fetch failed";
				throw new TtsProviderError("mistral", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TtsProviderError(
					"mistral",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TtsProviderError("mistral", "response body was not valid JSON", response.status, {
					cause,
				});
			}
			const parsed = v.safeParse(SpeechResponseSchema, raw);
			if (!parsed.success) {
				throw new TtsProviderError(
					"mistral",
					`response failed validation: ${parsed.issues.map((i) => i.message).join("; ")}`,
					response.status,
				);
			}

			let wavBytes: Uint8Array;
			try {
				wavBytes = Uint8Array.from(Buffer.from(parsed.output.audio_data, "base64"));
			} catch (cause) {
				throw new TtsProviderError("mistral", "audio_data was not valid base64", response.status, {
					cause,
				});
			}
			try {
				const { pcm, sampleRate } = readMonoWav(wavBytes);
				return { pcm, sampleRate };
			} catch (cause) {
				if (cause instanceof InvalidWavFormatError) {
					throw new TtsProviderError(
						"mistral",
						`audio_data did not decode to a mono int16 wav: ${cause.message}`,
						response.status,
						{ cause },
					);
				}
				throw cause;
			}
		},
	};
}

/**
 * Deterministic voice pick for a language. When the request carries a
 * region (`pt_br`), exact regional matches beat primary-subtag matches; a
 * primary-only request (`es`) treats every regional variant as equal.
 * Within a tier, preset slugs (alphabetical) beat cloned voices (oldest
 * `created_at` first, id as tiebreak) — presets are studio-produced and
 * stable, clones are whatever the org uploaded last.
 */
function pickVoiceForLanguage(
	items: readonly VoiceCatalogItem[],
	normalized: string,
): string | undefined {
	const primary = normalized.split("_")[0] ?? normalized;
	const tagsOf = (item: VoiceCatalogItem) =>
		(item.languages ?? []).map((l) => l.toLowerCase().replace("-", "_"));
	const byPrimary = items.filter((item) =>
		tagsOf(item).some((l) => (l.split("_")[0] ?? l) === primary),
	);
	const exact = normalized.includes("_")
		? items.filter((item) => tagsOf(item).includes(normalized))
		: [];
	const pool = exact.length > 0 ? exact : byPrimary;
	const presets = pool
		.filter((item) => typeof item.slug === "string" && item.slug.length > 0)
		.sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""));
	const first = presets[0]?.slug;
	if (first !== undefined && first !== null) return first;
	const clones = [...pool].sort(
		(a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
	);
	return clones[0]?.id;
}
