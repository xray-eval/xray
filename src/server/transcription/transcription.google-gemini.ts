import * as v from "valibot";

import { writeMonoWav } from "@/server/audio/audio.wav.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";

import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import type { FetchLike } from "./transcription.openai-whisper.ts";
import type {
	TranscriptionProvider,
	TranscriptionRequest,
	TranscriptionResult,
} from "./transcription.types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Audio understanding is supported on 2.5-flash. Pinned snapshot so a
// silent re-pointing of the floating alias doesn't drift transcription
// quality between runs. Operators override via XRAY_TRANSCRIPTION_MODEL.
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

// Gemini's generateContent response shape, validated at the provider
// boundary. We only read `candidates[0].content.parts[].text` (joined)
// and an optional `promptFeedback.blockReason` so a safety block surfaces
// as a distinct error instead of "empty candidates".
const GeminiPartSchema = v.object({
	text: v.optional(v.string()),
});
const GeminiContentSchema = v.object({
	parts: v.optional(v.array(GeminiPartSchema)),
});
const GeminiCandidateSchema = v.object({
	content: v.optional(GeminiContentSchema),
	finishReason: v.optional(v.string()),
});
const GeminiResponseSchema = v.object({
	candidates: v.optional(v.array(GeminiCandidateSchema)),
	promptFeedback: v.optional(
		v.object({
			blockReason: v.optional(v.string()),
		}),
	),
});

// The JSON the model is forced to produce via responseSchema. Language is
// best-effort: Gemini returns ISO-639-1 when confident, omits otherwise.
const TranscribedPayloadSchema = v.object({
	text: v.string(),
	language: v.optional(v.union([v.string(), v.null()])),
});

const SYSTEM_INSTRUCTION =
	"You are a verbatim audio transcriber. Transcribe the spoken content of the audio exactly as heard. Do not summarize, paraphrase, translate, or add commentary. If the audio contains no speech, return an empty string for text.";

const USER_PROMPT =
	'Transcribe the attached audio. Reply only with the JSON object {"text": "...", "language": "<ISO-639-1 or null>"}.';

export interface GoogleGeminiTranscriptionOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

function mergeAbortSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (external === undefined) return timeoutSignal;
	return AbortSignal.any([external, timeoutSignal]);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Google Gemini transcription provider. Wraps the mono PCM into a WAV and
 * sends it inline (base64) to `generateContent` with a JSON-schema-forced
 * response. v1 trade-off vs. the OpenAI Whisper provider: Gemini does not
 * produce signal-aligned word timings — `words` is always null. The
 * inspector's `words_json` column is already nullable so this is a
 * tolerated capability gap, not a contract break.
 *
 * The Cloud Speech-to-Text APIs have true word timings but sit behind a
 * different auth surface (service account) than the generativelanguage
 * endpoint this provider targets. A future provider file lands here once
 * that path matters.
 */
export function createGoogleGeminiTranscriptionProvider(
	opts: GoogleGeminiTranscriptionOptions,
): TranscriptionProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "google-gemini",
		model,
		async transcribe(input: TranscriptionRequest): Promise<TranscriptionResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("GOOGLE_API_KEY");
			}
			const wavBytes = writeMonoWav(input.audio, input.sampleRate);
			const body = {
				systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
				contents: [
					{
						role: "user",
						parts: [
							{ text: USER_PROMPT },
							{ inline_data: { mime_type: "audio/wav", data: bytesToBase64(wavBytes) } },
						],
					},
				],
				generationConfig: {
					temperature: 0,
					responseMimeType: "application/json",
					responseSchema: {
						type: "OBJECT",
						properties: {
							text: { type: "STRING" },
							language: { type: "STRING", nullable: true },
						},
						required: ["text"],
					},
				},
			};

			// Auth via `x-goog-api-key` header rather than `?key=...` query
			// string so the key doesn't land in upstream URL access logs or
			// in any error message that echoes the request URL.
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
				throw new TranscriptionProviderError("google-gemini", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TranscriptionProviderError(
					"google-gemini",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TranscriptionProviderError(
					"google-gemini",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}

			const content = extractGeminiText(raw);
			const payload = parseTranscribedPayload(content);

			// Duration is computed locally rather than asked-of-the-model.
			// The PCM length divided by sample rate is exact; relying on the
			// model would add a hallucination surface for a value we already
			// know.
			const durationMs = Math.max(0, Math.round((input.audio.length / input.sampleRate) * 1000));
			return {
				text: payload.text,
				language: payload.language ?? null,
				durationMs,
				words: null,
			};
		},
	};
}

function extractGeminiText(raw: unknown): string {
	const result = v.safeParse(GeminiResponseSchema, raw);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"google-gemini",
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const parsed = result.output;
	const blockReason = parsed.promptFeedback?.blockReason;
	if (blockReason !== undefined) {
		throw new TranscriptionProviderError(
			"google-gemini",
			`prompt blocked by safety filter: ${blockReason}`,
		);
	}
	const first = parsed.candidates?.[0];
	if (first === undefined) {
		throw new TranscriptionProviderError("google-gemini", "response candidates array was empty");
	}
	if (first.finishReason !== undefined && first.finishReason !== "STOP") {
		throw new TranscriptionProviderError(
			"google-gemini",
			`candidate finished with reason "${first.finishReason}" (expected STOP)`,
		);
	}
	const parts = first.content?.parts ?? [];
	const text = parts.map((p) => p.text ?? "").join("");
	if (text.length === 0) {
		throw new TranscriptionProviderError("google-gemini", "candidate content was empty");
	}
	return text;
}

function parseTranscribedPayload(content: string): { text: string; language: string | null } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new TranscriptionProviderError("google-gemini", "model output was not valid JSON", null, {
			cause,
		});
	}
	const result = v.safeParse(TranscribedPayloadSchema, parsed);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"google-gemini",
			`model output failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	return {
		text: result.output.text,
		language: result.output.language ?? null,
	};
}
