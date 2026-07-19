import { eq } from "drizzle-orm";

import { saveTtsConversationAudio } from "@/server/audio/audio.service.ts";
import { resamplePcm, writeMonoWav } from "@/server/audio/audio.wav.ts";
import { ttsSynthCache } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import type { TtsProvider } from "./tts.types.ts";

/** The 48kHz the LiveKit driver publishes; all stored turn audio uses it. */
const TARGET_SAMPLE_RATE = 48_000;

// Stored turn audio must clear the level the VAD calibration assumes:
// segmentation (audio.vad.ts) only marks frames voiced above ≈-23 dBFS mean
// energy, and provider/voice loudness varies wildly — Deepgram Aura's German
// voices ship raw linear16 near -33 dBFS RMS, which the VAD cannot see at
// all, so every scripted replay with such a turn died with
// `spec_vad_mismatch` (zero user segments in the mixdown). Peak-normalizing
// every synthesis to one fixed target (-1.4 dBFS peak) makes the stored WAV —
// and the driver-published audio recorded into the mixdown — level-
// deterministic regardless of provider or voice.
const TARGET_PEAK = 27_852;

function peakNormalize(pcm: Int16Array, targetPeak: number): Int16Array {
	let peak = 0;
	for (let i = 0; i < pcm.length; i++) {
		const a = Math.abs(pcm[i] ?? 0);
		if (a > peak) peak = a;
	}
	if (peak === 0) return pcm;
	const gain = targetPeak / peak;
	const out = new Int16Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) {
		out[i] = Math.max(-32_768, Math.min(32_767, Math.round((pcm[i] ?? 0) * gain)));
	}
	return out;
}

export interface TurnSynthesisInput {
	readonly text: string;
	/** Explicit per-turn voice from the spec. Wins over `voiceOverride`. */
	readonly voiceId?: string;
	/** Declared language of the turn (`de`, `en_us`). Only consulted when
	 *  neither `voiceId` nor `voiceOverride` picks a voice — it steers the
	 *  provider's default-voice resolution, nothing else. */
	readonly language?: string;
}

/** Synthesize one tts turn (or return its cached result): resolves the
 *  voice chain, checks the fingerprint cache, and on miss generates +
 *  stores the 48kHz mono WAV content-addressed under `tts/`. The optional
 *  `signal` is shared across a request's turns so one synthesis failure
 *  cancels the in-flight siblings. */
export type TurnSynthesizer = (
	input: TurnSynthesisInput,
	signal?: AbortSignal,
) => Promise<{ sha256: string }>;

export interface TurnSynthesizerDeps {
	readonly store: Store;
	readonly audioRoot: string;
	readonly provider: TtsProvider;
	/** Operator default voice (XRAY_TTS_VOICE). Loses to the turn's voiceId. */
	readonly voiceOverride?: string;
}

/**
 * Build the synthesizer the conversation upsert injects into
 * `materializeRequestTurns`.
 *
 * Determinism: the conversation hash folds in the *output* sha256, but
 * TTS output varies call-to-call — so the fingerprint
 * `sha256([provider, model, voice, text])` indexes the first synthesis in
 * `tts_synth_cache` and every later upsert of the same spec + config
 * reuses that sha. A cache row whose WAV file is missing (operator pruned
 * the audio dir but kept the DB) is treated as a miss and re-synthesized.
 *
 * Calls are memoized per-synthesizer (= per-request) so a spec repeating
 * the same text doesn't fan out duplicate provider calls racing to insert
 * the same fingerprint.
 */
export function createTurnSynthesizer(deps: TurnSynthesizerDeps): TurnSynthesizer {
	const inFlight = new Map<string, Promise<{ sha256: string }>>();
	return (input, signal) => {
		const job = (async () => {
			// Resolving the default may hit the provider's voice catalog, so it
			// only runs when neither the turn nor the operator picked a voice.
			const voice =
				input.voiceId ??
				deps.voiceOverride ??
				(await deps.provider.resolveDefaultVoice(input.language));
			// TARGET_PEAK is folded in so cache rows written before (or with a
			// different) normalization level are misses, not stale quiet audio.
			const fingerprintInput = JSON.stringify([
				deps.provider.name,
				deps.provider.model,
				voice,
				input.text,
				TARGET_PEAK,
			]);
			const fingerprint = await sha256Hex(new TextEncoder().encode(fingerprintInput));
			const existing = inFlight.get(fingerprint);
			if (existing !== undefined) return existing;
			const fresh = synthesizeOrReuse(deps, fingerprint, input.text, voice, signal);
			inFlight.set(fingerprint, fresh);
			return fresh;
		})();
		return job;
	};
}

async function synthesizeOrReuse(
	deps: TurnSynthesizerDeps,
	fingerprint: string,
	text: string,
	voice: string,
	signal: AbortSignal | undefined,
): Promise<{ sha256: string }> {
	const cached = deps.store.db
		.select()
		.from(ttsSynthCache)
		.where(eq(ttsSynthCache.fingerprint, fingerprint))
		.get();
	if (cached !== undefined) {
		const file = Bun.file(ttsAudioAbsolutePath(deps.audioRoot, cached.audioSha256));
		if (await file.exists()) return { sha256: cached.audioSha256 };
	}

	const result = await deps.provider.synthesize({
		text,
		voice,
		...(signal !== undefined ? { signal } : {}),
	});
	const pcm48k = peakNormalize(
		resamplePcm(result.pcm, result.sampleRate, TARGET_SAMPLE_RATE),
		TARGET_PEAK,
	);
	const wavBytes = writeMonoWav(pcm48k, TARGET_SAMPLE_RATE);
	const sha256 = await sha256Hex(wavBytes);
	await saveTtsConversationAudio(deps.audioRoot, sha256, wavBytes);
	deps.store.db
		.insert(ttsSynthCache)
		.values({
			fingerprint,
			audioSha256: sha256,
			provider: deps.provider.name,
			model: deps.provider.model,
			voice,
			createdAt: new Date().toISOString(),
		})
		.onConflictDoUpdate({
			target: ttsSynthCache.fingerprint,
			set: { audioSha256: sha256 },
		})
		.run();
	return { sha256 };
}

function ttsAudioAbsolutePath(audioRoot: string, sha256: string): string {
	return `${audioRoot}/tts/${sha256}.wav`;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
