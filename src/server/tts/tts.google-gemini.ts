import * as v from "valibot";

import { mergeAbortSignals } from "@/server/core/abort.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { TtsProviderError } from "./tts.errors.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./tts.types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// The only TTS-capable generativelanguage model line. Preview-named —
// Google has shipped no stable TTS snapshot yet, so drift is possible;
// operators pin a different model via XRAY_TTS_MODEL when one lands.
const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Kore";
// Fallback when the inlineData mimeType omits an explicit rate. Gemini TTS
// documents 24kHz L16 output.
const GEMINI_DEFAULT_RATE = 24_000;
const DEFAULT_TIMEOUT_MS = 120_000;

// Audio arrives as `inlineData`, not `text` — the shared
// `extractGeminiText` helper doesn't apply. Same envelope discipline:
// model only the path we read, surface safety blocks distinctly.
const GeminiAudioResponseSchema = v.object({
	candidates: v.optional(
		v.array(
			v.object({
				content: v.optional(
					v.object({
						parts: v.optional(
							v.array(
								v.object({
									inlineData: v.optional(
										v.object({
											mimeType: v.optional(v.string()),
											data: v.optional(v.string()),
										}),
									),
								}),
							),
						),
					}),
				),
				finishReason: v.optional(v.string()),
			}),
		),
	),
	promptFeedback: v.optional(v.object({ blockReason: v.optional(v.string()) })),
});

export interface GoogleGeminiTtsOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Google Gemini TTS provider. Sends `generateContent` with the AUDIO
 * response modality and a prebuilt voice; decodes the base64 inline L16
 * pcm at the rate declared in the part's mimeType. The synthesis service
 * resamples to 48kHz.
 */
export function createGoogleGeminiTtsProvider(opts: GoogleGeminiTtsOptions): TtsProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "google-gemini",
		model,
		defaultVoice: DEFAULT_VOICE,
		async synthesize(input: TtsRequest): Promise<TtsResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("GOOGLE_API_KEY");
			}
			const body = {
				contents: [{ role: "user", parts: [{ text: input.text }] }],
				generationConfig: {
					responseModalities: ["AUDIO"],
					speechConfig: {
						voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } },
					},
				},
			};

			const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers: {
						"x-goog-api-key": key,
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
				throw new TtsProviderError("google-gemini", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TtsProviderError(
					"google-gemini",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TtsProviderError(
					"google-gemini",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}
			return decodeInlineAudio(raw, response.status);
		},
	};
}

function decodeInlineAudio(raw: unknown, statusCode: number): TtsResult {
	const result = v.safeParse(GeminiAudioResponseSchema, raw);
	if (!result.success) {
		throw new TtsProviderError(
			"google-gemini",
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
			statusCode,
		);
	}
	const blockReason = result.output.promptFeedback?.blockReason;
	if (blockReason !== undefined) {
		throw new TtsProviderError(
			"google-gemini",
			`prompt blocked by safety filter: ${blockReason}`,
			statusCode,
		);
	}
	const first = result.output.candidates?.[0];
	if (first === undefined) {
		throw new TtsProviderError("google-gemini", "response candidates array was empty", statusCode);
	}
	const inline = (first.content?.parts ?? []).find((p) => p.inlineData?.data !== undefined);
	const data = inline?.inlineData?.data;
	if (data === undefined) {
		throw new TtsProviderError(
			"google-gemini",
			"response carried no inline audio part",
			statusCode,
		);
	}
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(Buffer.from(data, "base64"));
	} catch (cause) {
		throw new TtsProviderError("google-gemini", "inline audio was not valid base64", statusCode, {
			cause,
		});
	}
	if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
		throw new TtsProviderError(
			"google-gemini",
			`inline pcm body has invalid length ${bytes.byteLength}`,
			statusCode,
		);
	}
	const sampleRate = parseRateFromMimeType(inline?.inlineData?.mimeType) ?? GEMINI_DEFAULT_RATE;
	const pcm = new Int16Array(bytes.buffer.slice(0));
	return { pcm, sampleRate };
}

function parseRateFromMimeType(mimeType: string | undefined): number | null {
	if (mimeType === undefined) return null;
	const match = /rate=(\d+)/.exec(mimeType);
	const rate = match?.[1] !== undefined ? Number(match[1]) : Number.NaN;
	return Number.isInteger(rate) && rate > 0 ? rate : null;
}
