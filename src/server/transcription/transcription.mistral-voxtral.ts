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

const MISTRAL_TRANSCRIPTIONS_URL = "https://api.mistral.ai/v1/audio/transcriptions";
// Pinned dated snapshot — `voxtral-mini-latest` is a floating alias Mistral
// re-points across releases, and a moving STT model produces transcript
// drift between runs of the same replay. Operators pin a different snapshot
// via XRAY_TRANSCRIPTION_MODEL.
const DEFAULT_MODEL = "voxtral-mini-2602";
const DEFAULT_TIMEOUT_MS = 120_000;

// Voxtral transcription response shape, validated at the provider boundary
// per `.claude/rules/boundary-validation.md`. We model only the fields we
// read. With `timestamp_granularities[]=word` the per-word timings arrive
// as `segments` entries (one word each); there is no separate `words`
// array and no `duration` field in this API.
//
// All fields are optional defensively, mirroring the Whisper schema: a 200
// with a missing field should degrade to safe defaults, not fail the
// analyze chain.
const VoxtralSegmentSchema = v.object({
	text: v.optional(v.string()),
	start: v.optional(v.number()),
	end: v.optional(v.number()),
});
const VoxtralResponseSchema = v.object({
	text: v.optional(v.string()),
	language: v.optional(v.union([v.string(), v.null()])),
	segments: v.optional(v.union([v.array(VoxtralSegmentSchema), v.null()])),
});

export interface MistralVoxtralOptions {
	/** Read at call time, not at construction — env can be loaded between server
	 *  boot and the first transcription request. */
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Mistral Voxtral transcription provider. Wraps the mono PCM into a wav
 * before sending — the transcriptions endpoint accepts file uploads and
 * wav is the only format we have a built-in encoder for.
 *
 * Word timings come back as one `segments` entry per word when
 * `timestamp_granularities[]=word` is requested; mapped into the same
 * `words` shape the Whisper provider produces. Mistral documents
 * `timestamp_granularities` as incompatible with `language`, so a request
 * carrying a language hint sends the hint and skips the timestamps
 * (transcript correctness beats word timings; the analyze-replay caller
 * never passes a hint, so the production path always gets words).
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
			const form = new FormData();
			form.append("file", new File([wavBytes], "audio.wav", { type: "audio/wav" }));
			form.append("model", model);
			if (input.language !== undefined) {
				form.append("language", input.language);
			} else {
				form.append("timestamp_granularities[]", "word");
			}

			let response: Response;
			try {
				response = await fetchImpl(MISTRAL_TRANSCRIPTIONS_URL, {
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

			// Duration is computed locally rather than read off the response —
			// the API reports only integer `usage.prompt_audio_seconds`, and the
			// PCM length divided by sample rate is exact.
			const durationMs = Math.max(0, Math.round((input.audio.length / input.sampleRate) * 1000));
			return parseVoxtralResponse(raw, durationMs);
		},
	};
}

function parseVoxtralResponse(raw: unknown, durationMs: number): TranscriptionResult {
	const result = v.safeParse(VoxtralResponseSchema, raw);
	if (!result.success) {
		throw new TranscriptionProviderError(
			"mistral-voxtral",
			`response body failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const parsed = result.output;
	const segments = parsed.segments ?? null;
	// Word segments carry the leading inter-word space (` world,`) — trim so
	// the stored words match what the Whisper provider produces.
	const words =
		segments !== null
			? segments
					.map((s) => {
						if (s.text === undefined || s.start === undefined || s.end === undefined) return null;
						const text = s.text.trim();
						if (text.length === 0) return null;
						return {
							text,
							startMs: Math.max(0, Math.round(s.start * 1000)),
							endMs: Math.max(0, Math.round(s.end * 1000)),
						};
					})
					.filter((w): w is { text: string; startMs: number; endMs: number } => w !== null)
			: null;
	return {
		text: parsed.text ?? "",
		language: parsed.language ?? null,
		durationMs,
		words: words !== null && words.length > 0 ? words : null,
	};
}
