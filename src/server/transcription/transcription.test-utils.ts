import type { TranscriptionProvider, TranscriptionResult } from "./transcription.types.ts";

export interface FakeTranscriptionProviderOptions {
	/** Static text returned for every transcribe() call. */
	readonly text?: string;
	/** Optional per-call override — `text` is then used as the fallback. */
	readonly textFor?: (input: { sampleRate: number; sampleCount: number }) => string;
	/** Make the provider always throw. */
	readonly error?: Error;
}

/**
 * In-memory transcription provider for tests. Returns deterministic
 * `TranscriptionResult` payloads without touching the network. Records
 * every call so tests can assert ordering / per-channel input.
 */
export interface FakeTranscriptionProvider extends TranscriptionProvider {
	readonly calls: ReadonlyArray<{ sampleRate: number; sampleCount: number }>;
}

export function makeFakeTranscriptionProvider(
	opts: FakeTranscriptionProviderOptions = {},
): FakeTranscriptionProvider {
	const calls: { sampleRate: number; sampleCount: number }[] = [];
	return {
		name: "fake-transcription",
		model: "fake-1",
		get calls() {
			return calls;
		},
		async transcribe(input): Promise<TranscriptionResult> {
			calls.push({ sampleRate: input.sampleRate, sampleCount: input.audio.length });
			if (opts.error !== undefined) throw opts.error;
			const text =
				opts.textFor?.({ sampleRate: input.sampleRate, sampleCount: input.audio.length }) ??
				opts.text ??
				"fake transcript";
			const durationMs = Math.round((input.audio.length / input.sampleRate) * 1000);
			return { text, language: "en", durationMs, words: null };
		},
	};
}
