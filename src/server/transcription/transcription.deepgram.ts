import * as v from "valibot";

import { writeMonoWav } from "@/server/audio/audio.wav.ts";
import { mergeAbortSignals } from "@/server/core/abort.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";

import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import type {
	TranscriptionProvider,
	TranscriptionRequest,
	TranscriptionResult,
} from "./transcription.types.ts";

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
// Deepgram model ids are stable family names (nova-3, nova-2) — there is
// no dated-snapshot variant to pin, so this is as pinned as their API
// allows. Operators override via XRAY_TRANSCRIPTION_MODEL.
const DEFAULT_MODEL = "nova-3";
const DEFAULT_TIMEOUT_MS = 120_000;

// Deepgram /v1/listen response, modeled only down to the paths we read:
// first channel, first alternative. All fields optional defensively,
// mirroring the Whisper schema — a 200 with a missing field degrades to
// safe defaults instead of failing the analyze chain.
const DeepgramWordSchema = v.object({
	word: v.optional(v.string()),
	punctuated_word: v.optional(v.string()),
	start: v.optional(v.number()),
	end: v.optional(v.number()),
});
const DeepgramResponseSchema = v.object({
	results: v.object({
		channels: v.array(
			v.object({
				detected_language: v.optional(v.union([v.string(), v.null()])),
				alternatives: v.array(
					v.object({
						transcript: v.optional(v.string()),
						words: v.optional(v.union([v.array(DeepgramWordSchema), v.null()])),
					}),
				),
			}),
		),
	}),
});

export interface DeepgramOptions {
	/** Read at call time, not at construction — env can be loaded between server
	 *  boot and the first transcription request. */
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Deepgram transcription provider (Nova family). Sends the mono PCM as a
 * WAV body to `/v1/listen` — a purpose-built batch ASR endpoint, so unlike
 * the chat-based providers it returns signal-aligned word timings
 * (`punctuated_word` + start/end seconds, mapped into the same `words`
 * shape the Whisper provider produces). Language: the turn's hint is sent
 * as `language=`; without a hint `detect_language=true` asks Deepgram to
 * detect it (multilingual by default, not English-biased).
 */
export function createDeepgramProvider(opts: DeepgramOptions): TranscriptionProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "deepgram-nova",
		model,
		async transcribe(input: TranscriptionRequest): Promise<TranscriptionResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("DEEPGRAM_API_KEY");
			}
			const wavBytes = writeMonoWav(input.audio, input.sampleRate);
			const params = new URLSearchParams({ model, smart_format: "true" });
			if (input.language !== undefined) params.set("language", input.language);
			else params.set("detect_language", "true");

			let response: Response;
			try {
				response = await fetchImpl(`${DEEPGRAM_LISTEN_URL}?${params}`, {
					method: "POST",
					headers: {
						authorization: `Token ${key}`,
						"content-type": "audio/wav",
					},
					body: wavBytes,
					signal: mergeAbortSignals(input.signal, timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
						: cause instanceof Error && cause.name === "AbortError"
							? "fetch aborted by caller"
							: "fetch failed";
				throw new TranscriptionProviderError("deepgram-nova", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TranscriptionProviderError(
					"deepgram-nova",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TranscriptionProviderError(
					"deepgram-nova",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}
			return parseDeepgramResponse(raw, input);
		},
	};
}

function parseDeepgramResponse(raw: unknown, input: TranscriptionRequest): TranscriptionResult {
	const result = v.safeParse(DeepgramResponseSchema, raw);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"deepgram-nova",
			`response body failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const channel = result.output.results.channels[0];
	const alternative = channel?.alternatives[0];
	if (channel === undefined || alternative === undefined) {
		throw new TranscriptionProviderError(
			"deepgram-nova",
			"response contained no transcription alternatives",
		);
	}
	const wordsRaw = alternative.words ?? null;
	const words =
		wordsRaw !== null
			? wordsRaw
					.map((w) => {
						const text = w.punctuated_word ?? w.word;
						if (text === undefined || w.start === undefined || w.end === undefined) {
							return null;
						}
						return {
							text,
							startMs: Math.max(0, Math.round(w.start * 1000)),
							endMs: Math.max(0, Math.round(w.end * 1000)),
						};
					})
					.filter((w): w is { text: string; startMs: number; endMs: number } => w !== null)
			: null;
	// Duration is computed locally rather than read off the response —
	// the PCM length divided by sample rate is exact for the bytes we sent.
	const durationMs = Math.max(0, Math.round((input.audio.length / input.sampleRate) * 1000));
	return {
		text: alternative.transcript ?? "",
		language: channel.detected_language ?? input.language ?? null,
		durationMs,
		words: words !== null && words.length > 0 ? words : null,
	};
}
