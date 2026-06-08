export interface TtsRequest {
	readonly text: string;
	/** Provider-specific voice id. Callers resolve the default chain
	 *  (turn voice_id → XRAY_TTS_VOICE → provider default) before calling. */
	readonly voice: string;
	readonly signal?: AbortSignal;
}

/**
 * Synthesized speech in the provider's native rate. Callers resample to
 * the 48kHz the LiveKit driver publishes — providers return what the API
 * gives them (24kHz for all three v1 backends) so the resample policy
 * lives in one place, not three.
 */
export interface TtsResult {
	readonly pcm: Int16Array;
	readonly sampleRate: number;
}

/**
 * Interface implemented by every TTS back-end. Synthesizes the user-side
 * audio for `{kind: "tts"}` conversation turns during the
 * `POST /v1/conversations` upsert. Same shape discipline as
 * `TranscriptionProvider` / `JudgeProvider`: one file per provider, one
 * line in the provider selector.
 */
export interface TtsProvider {
	/** Stable name folded into the synth-cache fingerprint. */
	readonly name: string;
	/** Stable model id folded into the synth-cache fingerprint. */
	readonly model: string;
	/** Voice used when neither the turn nor XRAY_TTS_VOICE picks one. */
	readonly defaultVoice: string;
	synthesize(input: TtsRequest): Promise<TtsResult>;
}
