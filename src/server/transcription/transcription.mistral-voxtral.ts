import * as v from "valibot";

import { writeMonoWav } from "@/server/audio/audio.wav.ts";
import { mergeAbortSignals } from "@/server/core/abort.ts";
import { bytesToBase64 } from "@/server/core/base64.ts";
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

const MISTRAL_CHAT_URL = "https://api.mistral.ai/v1/chat/completions";
// Voxtral Small (24B) is Mistral's largest audio-capable model — the only
// one with `capabilities.audio` on the models API, and it is chat-only:
// the dedicated /v1/audio/transcriptions endpoint rejects it ("Invalid
// model", verified live 2026-07-18) and serves just the voxtral-mini
// transcribe family. Quality-over-speed default, so transcription rides
// chat completions with an `input_audio` block. Pinned dated snapshot —
// `voxtral-small-latest` is a floating alias and a moving STT model
// produces transcript drift between runs of the same replay.
const DEFAULT_MODEL = "voxtral-small-2507";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOKENS = 8_192;

// The JSON the model is forced to produce via `response_format:
// json_object`. Language is best-effort ISO-639-1.
const TranscribedPayloadSchema = v.object({
	text: v.string(),
	language: v.optional(v.union([v.string(), v.null()])),
});

const ChatCompletionsResponseSchema = v.object({
	choices: v.array(
		v.object({
			message: v.object({
				content: v.string(),
			}),
		}),
	),
});

const SYSTEM_PROMPT =
	'You are a verbatim audio transcriber. Transcribe the spoken content of the audio exactly as heard, in whatever language is spoken. Do not summarize, paraphrase, translate, or add commentary. If the audio contains no speech, return an empty string for text. Reply only with the JSON object {"text": "...", "language": "<ISO-639-1 or null>"}.';

const USER_PROMPT = "Transcribe the attached audio.";

export interface MistralVoxtralOptions {
	/** Read at call time, not at construction — env can be loaded between server
	 *  boot and the first transcription request. */
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Mistral Voxtral transcription provider. Wraps the mono PCM into a WAV
 * and sends it inline (base64) as a chat `input_audio` block, with a
 * JSON-mode-forced `{text, language}` reply.
 *
 * Trade-off vs. the previous /v1/audio/transcriptions integration: no
 * signal-aligned word timings — `words` is always null (same tolerated
 * capability gap as the Gemini provider; `turn_transcripts.words_json` is
 * nullable). In exchange the transcript comes from the 24B model instead
 * of the 3B mini, and the reply carries a detected language.
 */
export function createMistralVoxtralProvider(opts: MistralVoxtralOptions): TranscriptionProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "mistral-voxtral",
		model,
		async transcribe(input: TranscriptionRequest): Promise<TranscriptionResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("MISTRAL_API_KEY");
			}
			const wavBytes = writeMonoWav(input.audio, input.sampleRate);
			const prompt =
				input.language !== undefined
					? `${USER_PROMPT} The audio is expected to be in "${input.language}".`
					: USER_PROMPT;
			const body = {
				model,
				temperature: 0,
				max_tokens: MAX_TOKENS,
				response_format: { type: "json_object" as const },
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{
						role: "user",
						content: [
							{ type: "text", text: prompt },
							{
								type: "input_audio",
								input_audio: { data: bytesToBase64(wavBytes), format: "wav" },
							},
						],
					},
				],
			};

			let response: Response;
			try {
				response = await fetchImpl(MISTRAL_CHAT_URL, {
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
				throw new TranscriptionProviderError("mistral-voxtral", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TranscriptionProviderError(
					"mistral-voxtral",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new TranscriptionProviderError(
					"mistral-voxtral",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}

			const content = extractMessageContent(raw);
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

function extractMessageContent(raw: unknown): string {
	const result = v.safeParse(ChatCompletionsResponseSchema, raw);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"mistral-voxtral",
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const first = result.output.choices[0];
	if (first === undefined) {
		throw new TranscriptionProviderError("mistral-voxtral", "response choices array was empty");
	}
	return first.message.content;
}

function parseTranscribedPayload(content: string): { text: string; language: string | null } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new TranscriptionProviderError(
			"mistral-voxtral",
			"model output was not valid JSON",
			null,
			{ cause },
		);
	}
	const result = v.safeParse(TranscribedPayloadSchema, parsed);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"mistral-voxtral",
			`model output failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	return {
		text: result.output.text,
		language: result.output.language ?? null,
	};
}
