export interface TranscriptionResult {
	readonly text: string;
	readonly language: string | null;
	readonly durationMs: number;
	readonly words: ReadonlyArray<{ text: string; startMs: number; endMs: number }> | null;
}

export interface TranscriptionRequest {
	readonly audio: Int16Array;
	readonly sampleRate: number;
	readonly language?: string;
	/**
	 * Optional external abort signal — when callers run several
	 * transcriptions in parallel and one fails, the orchestrator aborts the
	 * others so they don't keep burning provider quota. The provider merges
	 * this with its own per-request timeout.
	 */
	readonly signal?: AbortSignal;
}

export interface TranscriptionProvider {
	readonly name: string;
	readonly model: string;
	transcribe(input: TranscriptionRequest): Promise<TranscriptionResult>;
}
