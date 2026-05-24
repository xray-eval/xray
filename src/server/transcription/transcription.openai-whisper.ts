import { writeMonoWav } from "@/server/audio/audio.wav.ts";

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

/**
 * Minimal subset of `fetch` we depend on. Bun's `typeof fetch` includes a
 * `preconnect` static method we don't use, and matching it would force
 * every test stub to ship a stub `preconnect` for no reason. Accepting
 * `FetchLike` keeps the seam thin and the tests honest.
 */
export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

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
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
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
					`HTTP ${response.status}: ${detail.slice(0, 512)}`,
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

interface WhisperRawResponse {
	text?: unknown;
	language?: unknown;
	duration?: unknown;
	words?: unknown;
}

interface WhisperRawWord {
	word?: unknown;
	start?: unknown;
	end?: unknown;
}

function parseWhisperResponse(raw: unknown): TranscriptionResult {
	if (!isWhisperRawResponse(raw)) {
		throw new TranscriptionProviderError("openai-whisper", "response body was not an object");
	}
	const text = typeof raw.text === "string" ? raw.text : "";
	const language = typeof raw.language === "string" ? raw.language : null;
	const durationSec = typeof raw.duration === "number" ? raw.duration : 0;
	const durationMs = Math.max(0, Math.round(durationSec * 1000));
	const words = Array.isArray(raw.words)
		? raw.words
				.map(parseWhisperWord)
				.filter((w): w is { text: string; startMs: number; endMs: number } => w !== null)
		: null;
	return { text, language, durationMs, words: words && words.length > 0 ? words : null };
}

function parseWhisperWord(w: unknown): { text: string; startMs: number; endMs: number } | null {
	if (!isWhisperRawWord(w)) return null;
	if (typeof w.word !== "string") return null;
	if (typeof w.start !== "number" || typeof w.end !== "number") return null;
	return {
		text: w.word,
		startMs: Math.max(0, Math.round(w.start * 1000)),
		endMs: Math.max(0, Math.round(w.end * 1000)),
	};
}

function isWhisperRawResponse(value: unknown): value is WhisperRawResponse {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhisperRawWord(value: unknown): value is WhisperRawWord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
