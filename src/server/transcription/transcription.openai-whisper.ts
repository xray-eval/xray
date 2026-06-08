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

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_TIMEOUT_MS = 120_000;

// Whisper `verbose_json` response shape, validated at the provider boundary.
// Per `.claude/rules/boundary-validation.md`, every byte from an external
// system passes through Valibot before any other code reads it. We model
// only the fields we read; unknown keys are dropped (default `v.object`).
//
// `text`, `language`, and `duration` are all marked optional because OpenAI
// has historically returned them missing on edge cases (zero-duration
// inputs, certain error fall-throughs that still produced a 200). Coerce
// missing/null values to safe defaults at the call site so the row insert
// still has the columns it needs.
const WhisperWordSchema = v.object({
	word: v.optional(v.string()),
	start: v.optional(v.number()),
	end: v.optional(v.number()),
});
const WhisperResponseSchema = v.object({
	text: v.optional(v.string()),
	language: v.optional(v.union([v.string(), v.null()])),
	duration: v.optional(v.union([v.number(), v.null()])),
	words: v.optional(v.union([v.array(WhisperWordSchema), v.null()])),
});

export interface OpenAIWhisperOptions {
	/** Read at call time, not at construction — env can be loaded between server
	 *  boot and the first transcription request. */
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * OpenAI Whisper transcription provider. Wraps the mono PCM into a wav
 * before sending — Whisper accepts wav/mp3/m4a/etc., wav is the only
 * format we have a built-in encoder for.
 *
 * `verbose_json` response format gives us per-word timings; consumed by
 * the analyze-replay job and stored as `turn_transcripts.words_json` for
 * future inspector use (word-level highlighting in the UI).
 */
export function createOpenAIWhisperProvider(opts: OpenAIWhisperOptions): TranscriptionProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "openai-whisper",
		model,
		async transcribe(input: TranscriptionRequest): Promise<TranscriptionResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("OPENAI_API_KEY");
			}
			const wavBytes = writeMonoWav(input.audio, input.sampleRate);
			const form = new FormData();
			form.append("file", new File([wavBytes], "audio.wav", { type: "audio/wav" }));
			form.append("model", model);
			form.append("response_format", "verbose_json");
			form.append("timestamp_granularities[]", "word");
			if (input.language !== undefined) form.append("language", input.language);

			let response: Response;
			try {
				response = await fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
					method: "POST",
					headers: { authorization: `Bearer ${key}` },
					body: form,
					signal: mergeAbortSignals(input.signal, timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
						: cause instanceof Error && cause.name === "AbortError"
							? "fetch aborted by caller"
							: "fetch failed";
				throw new TranscriptionProviderError("openai-whisper", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TranscriptionProviderError(
					"openai-whisper",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TranscriptionProviderError(
					"openai-whisper",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}
			return parseWhisperResponse(raw);
		},
	};
}

function parseWhisperResponse(raw: unknown): TranscriptionResult {
	const result = v.safeParse(WhisperResponseSchema, raw);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"openai-whisper",
			`response body failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const parsed = result.output;
	const text = parsed.text ?? "";
	const language = parsed.language ?? null;
	const durationSec = parsed.duration ?? 0;
	const durationMs = Math.max(0, Math.round(durationSec * 1000));
	const wordsRaw = parsed.words ?? null;
	const words =
		wordsRaw !== null
			? wordsRaw
					.map((w) => {
						if (w.word === undefined || w.start === undefined || w.end === undefined) {
							return null;
						}
						return {
							text: w.word,
							startMs: Math.max(0, Math.round(w.start * 1000)),
							endMs: Math.max(0, Math.round(w.end * 1000)),
						};
					})
					.filter((w): w is { text: string; startMs: number; endMs: number } => w !== null)
			: null;
	return { text, language, durationMs, words: words && words.length > 0 ? words : null };
}
