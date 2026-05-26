export interface TranscriptionResult {
	readonly text: string;
	readonly language: string | null;
	readonly durationMs: number;
	readonly words: ReadonlyArray<{ text: string; startMs: number; endMs: number }> | null;
}

export interface TranscriptionRequest {
	/** Mono int16 PCM samples. Provider implementations wrap as wav before send. */
	readonly audio: Int16Array;
	readonly sampleRate: number;
	/** ISO-639-1 language hint passed through to the provider. */
	readonly language?: string;
	/**
	 * Optional external abort signal — when callers run several
	 * transcriptions in parallel and one fails, the orchestrator aborts the
	 * others so they don't keep burning provider quota. The provider merges
	 * this with its own per-request timeout.
	 */
	readonly signal?: AbortSignal;
}

/**
 * Interface implemented by every transcription back-end. v1 ships one
 * implementation (OpenAI Whisper); the abstraction exists so a future
 * Deepgram / local-whisper variant slots in as one file + one line in the
 * provider selector.
 */
export interface TranscriptionProvider {
	/** Stable name persisted on `turn_transcripts.provider`. */
	readonly name: string;
	/** Stable model id persisted on `turn_transcripts.model`. */
	readonly model: string;
	transcribe(input: TranscriptionRequest): Promise<TranscriptionResult>;
}
