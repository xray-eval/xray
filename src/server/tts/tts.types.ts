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
 * Interface implemented by every TTS back-end — synthesizes user-side audio
 * for `{kind: "tts"}` turns during the `POST /v1/conversations` upsert.
 */
export interface TtsProvider {
	readonly name: string;
	readonly model: string;
	/**
	 * Voice used when neither the turn's `voice_id` nor `XRAY_TTS_VOICE` picks
	 * one. `language` (the turn's tag, `de` / `en_us`) steers providers with
	 * language-specific voices (Mistral — may need a catalog request, hence
	 * async); multilingual providers ignore it. Throws
	 * `NoTtsVoiceForLanguageError` when the language has no voice at all — a
	 * silently mispronouncing fallback would be worse than the 4xx.
	 */
	resolveDefaultVoice(language?: string): Promise<string>;
	synthesize(input: TtsRequest): Promise<TtsResult>;
}
