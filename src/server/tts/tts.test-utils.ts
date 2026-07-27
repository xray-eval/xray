import type { TtsProvider, TtsResult } from "./tts.types.ts";

export interface FakeTtsProviderOptions {
	readonly pcm?: Int16Array;
	readonly sampleRate?: number;
	readonly error?: Error;
	/** Per-call PCM override — vary output across calls to simulate
	 *  non-deterministic synthesis. */
	readonly pcmFor?: (call: { text: string; voice: string; callIndex: number }) => Int16Array;
	/** Voice returned by resolveDefaultVoice (default "fake-voice");
	 *  receives the language so tests can assert language-aware picks. */
	readonly defaultVoiceFor?: (language?: string) => string;
}

export interface FakeTtsProvider extends TtsProvider {
	readonly calls: ReadonlyArray<{ text: string; voice: string }>;
	readonly resolveCalls: ReadonlyArray<string | undefined>;
}

/**
 * In-memory TTS provider for tests. Returns deterministic pcm without
 * touching the network; records every call so tests can assert the
 * synth-cache actually short-circuits repeat synthesis.
 */
export function makeFakeTtsProvider(opts: FakeTtsProviderOptions = {}): FakeTtsProvider {
	const calls: { text: string; voice: string }[] = [];
	const resolveCalls: (string | undefined)[] = [];
	return {
		name: "fake-tts",
		model: "fake-tts-1",
		get calls() {
			return calls;
		},
		get resolveCalls() {
			return resolveCalls;
		},
		async resolveDefaultVoice(language?: string): Promise<string> {
			resolveCalls.push(language);
			return opts.defaultVoiceFor?.(language) ?? "fake-voice";
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
