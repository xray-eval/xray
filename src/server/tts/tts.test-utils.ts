import type { TtsProvider, TtsResult } from "./tts.types.ts";

export interface FakeTtsProviderOptions {
	/** PCM returned for every synthesize() call (default: 480 samples of silence). */
	readonly pcm?: Int16Array;
	readonly sampleRate?: number;
	/** Make the provider always throw. */
	readonly error?: Error;
	/** Per-call PCM override — vary output across calls to simulate
	 *  non-deterministic synthesis. */
	readonly pcmFor?: (call: { text: string; voice: string; callIndex: number }) => Int16Array;
}

export interface FakeTtsProvider extends TtsProvider {
	readonly calls: ReadonlyArray<{ text: string; voice: string }>;
}

/**
 * In-memory TTS provider for tests. Returns deterministic pcm without
 * touching the network; records every call so tests can assert the
 * synth-cache actually short-circuits repeat synthesis.
 */
export function makeFakeTtsProvider(opts: FakeTtsProviderOptions = {}): FakeTtsProvider {
	const calls: { text: string; voice: string }[] = [];
	return {
		name: "fake-tts",
		model: "fake-tts-1",
		defaultVoice: "fake-voice",
		get calls() {
			return calls;
		},
		async synthesize(input): Promise<TtsResult> {
			const callIndex = calls.length;
			calls.push({ text: input.text, voice: input.voice });
			if (opts.error !== undefined) throw opts.error;
			const pcm =
				opts.pcmFor?.({ text: input.text, voice: input.voice, callIndex }) ??
				opts.pcm ??
				new Int16Array(480);
			return { pcm, sampleRate: opts.sampleRate ?? 48_000 };
		},
	};
}
