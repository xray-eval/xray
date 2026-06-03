import * as v from "valibot";

import { InvalidWavFormatError } from "@/server/audio/audio.errors.ts";
import { readMonoWav } from "@/server/audio/audio.wav.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { TtsProviderError } from "./tts.errors.ts";
import type { TtsProvider, TtsRequest, TtsResult } from "./tts.types.ts";

const MISTRAL_SPEECH_URL = "https://api.mistral.ai/v1/audio/speech";
// Pinned dated snapshot — same drift rationale as the voxtral STT default.
const DEFAULT_MODEL = "voxtral-mini-tts-2603";
// Preset slug from Mistral's voice catalog (`GET /v1/audio/voices`). The
// API has no implicit default: requests without a voice_id are rejected
// with "Either ref_audio or voice must be provided."
const DEFAULT_VOICE = "en_paul_neutral";
const DEFAULT_TIMEOUT_MS = 120_000;

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
 * Mistral Voxtral TTS provider. Decodes the base64 WAV envelope and
 * returns pcm at the WAV's declared rate (24kHz as of voxtral-mini-tts);
 * the synthesis service resamples to 48kHz.
 */
export function createMistralTtsProvider(opts: MistralTtsOptions): TtsProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "mistral",
		model,
		defaultVoice: DEFAULT_VOICE,
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

function mergeAbortSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (external === undefined) return timeoutSignal;
	return AbortSignal.any([external, timeoutSignal]);
}
