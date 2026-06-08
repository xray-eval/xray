import { mergeAbortSignals } from "@/server/core/abort.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { TtsProviderError } from "./tts.errors.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./tts.types.ts";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
// Same model the SDK used before synthesis moved server-side, so existing
// conversations keep their voice character across the migration. Operators
// override via XRAY_TTS_MODEL.
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "alloy";
// `response_format: "pcm"` returns raw little-endian int16 mono at 24kHz —
// documented constant, not present in the response (the body is headerless).
const OPENAI_PCM_RATE = 24_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpenAITtsOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * OpenAI TTS provider. Requests raw PCM (headerless int16 @ 24kHz) so no
 * container parsing is needed; the synthesis service resamples to 48kHz.
 */
export function createOpenAITtsProvider(opts: OpenAITtsOptions): TtsProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "openai",
		model,
		defaultVoice: DEFAULT_VOICE,
		async synthesize(input: TtsRequest): Promise<TtsResult> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("OPENAI_API_KEY");
			}
			const body = {
				model,
				input: input.text,
				voice: input.voice,
				response_format: "pcm" as const,
			};

			let response: Response;
			try {
				response = await fetchImpl(OPENAI_SPEECH_URL, {
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
				throw new TtsProviderError("openai", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new TtsProviderError(
					"openai",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let buffer: ArrayBuffer;
			try {
				buffer = await response.arrayBuffer();
			} catch (cause) {
				throw new TtsProviderError("openai", "could not read response body", response.status, {
					cause,
				});
			}
			if (buffer.byteLength === 0) {
				throw new TtsProviderError("openai", "response pcm body was empty", response.status);
			}
			if (buffer.byteLength % 2 !== 0) {
				throw new TtsProviderError(
					"openai",
					`response pcm body has odd length ${buffer.byteLength}`,
					response.status,
				);
			}
			return { pcm: new Int16Array(buffer), sampleRate: OPENAI_PCM_RATE };
		},
	};
}
