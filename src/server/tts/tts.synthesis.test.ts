import { join } from "node:path";

import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { readMonoWav } from "@/server/audio/audio.wav.ts";
import { ttsSynthCache } from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createTurnSynthesizer } from "./tts.synthesis.ts";
import { makeFakeTtsProvider } from "./tts.test-utils.ts";
import { afterEach, describe, expect, it } from "bun:test";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function makeDeps() {
	const store = makeTempStore();
	const { path: audioRoot, dispose } = makeTempAudioRoot();
	cleanups.push(dispose);
	cleanups.push(() => {
		store.close();
	});
	return { store, audioRoot };
}

describe("createTurnSynthesizer", () => {
	it("synthesizes, stores a 48kHz mono wav at tts/<sha256>.wav, and returns the sha", async () => {
		const { store, audioRoot } = makeDeps();
		const provider = makeFakeTtsProvider({ pcm: new Int16Array([0, 1000, -1000]) });
		const synthesize = createTurnSynthesizer({ store, audioRoot, provider });
		const { sha256 } = await synthesize({ text: "hello" });
		expect(sha256).toMatch(/^[0-9a-f]{64}$/);
		const file = Bun.file(join(audioRoot, "tts", `${sha256}.wav`));
		expect(await file.exists()).toBe(true);
		const parsed = readMonoWav(new Uint8Array(await file.arrayBuffer()));
		expect(parsed.sampleRate).toBe(48_000);
		expect([...parsed.pcm]).toEqual([0, 1000, -1000]);
	});

	it("resamples 24kHz provider output to 48kHz", async () => {
		const { store, audioRoot } = makeDeps();
		const provider = makeFakeTtsProvider({
			pcm: new Int16Array([0, 100, 200]),
			sampleRate: 24_000,
		});
		const synthesize = createTurnSynthesizer({ store, audioRoot, provider });
		const { sha256 } = await synthesize({ text: "hello" });
		const file = Bun.file(join(audioRoot, "tts", `${sha256}.wav`));
		const parsed = readMonoWav(new Uint8Array(await file.arrayBuffer()));
		expect(parsed.sampleRate).toBe(48_000);
		expect(parsed.pcm.length).toBe(6);
	});

	it("returns the cached sha on a fingerprint hit without calling the provider again", async () => {
		const { store, audioRoot } = makeDeps();
		// Non-deterministic provider: every call yields different bytes. The
		// cache must pin the first result.
		const provider = makeFakeTtsProvider({
			pcmFor: ({ callIndex }) => new Int16Array([callIndex + 1, callIndex + 2]),
		});
		const synthesize = createTurnSynthesizer({ store, audioRoot, provider });
		const first = await synthesize({ text: "same text" });

		const synthesizeAgain = createTurnSynthesizer({ store, audioRoot, provider });
		const second = await synthesizeAgain({ text: "same text" });
		expect(second.sha256).toBe(first.sha256);
		expect(provider.calls).toHaveLength(1);
	});

	it("re-synthesizes when the cache row exists but the audio file is gone", async () => {
		const { store, audioRoot } = makeDeps();
		const provider = makeFakeTtsProvider({ pcm: new Int16Array([5, 6, 7]) });
		const synthesize = createTurnSynthesizer({ store, audioRoot, provider });
		const first = await synthesize({ text: "x" });
		await Bun.file(join(audioRoot, "tts", `${first.sha256}.wav`)).delete();

		const second = await createTurnSynthesizer({ store, audioRoot, provider })({ text: "x" });
		expect(provider.calls).toHaveLength(2);
		const file = Bun.file(join(audioRoot, "tts", `${second.sha256}.wav`));
		expect(await file.exists()).toBe(true);
	});

	it("memoizes concurrent same-fingerprint calls within one synthesizer", async () => {
		const { store, audioRoot } = makeDeps();
		const provider = makeFakeTtsProvider({
			pcmFor: ({ callIndex }) => new Int16Array([callIndex]),
		});
		const synthesize = createTurnSynthesizer({ store, audioRoot, provider });
		const [a, b] = await Promise.all([synthesize({ text: "dup" }), synthesize({ text: "dup" })]);
		expect(a.sha256).toBe(b.sha256);
		expect(provider.calls).toHaveLength(1);
	});

	it("distinguishes fingerprints by voice: explicit voiceId, voiceOverride, provider default", async () => {
		const { store, audioRoot } = makeDeps();
		const provider = makeFakeTtsProvider({ pcm: new Int16Array([1]) });
		const withOverride = createTurnSynthesizer({
			store,
			audioRoot,
			provider,
			voiceOverride: "env-voice",
		});
		await withOverride({ text: "t" });
		expect(provider.calls[0]?.voice).toBe("env-voice");

		await withOverride({ text: "t", voiceId: "turn-voice" });
		expect(provider.calls[1]?.voice).toBe("turn-voice");

		const noOverride = createTurnSynthesizer({ store, audioRoot, provider });
		await noOverride({ text: "t" });
		expect(provider.calls[2]?.voice).toBe("fake-voice");
	});

	it("stamps provider, model, and voice on the cache row", async () => {
		const { store, audioRoot } = makeDeps();
		const provider = makeFakeTtsProvider({ pcm: new Int16Array([1]) });
		const synthesize = createTurnSynthesizer({ store, audioRoot, provider });
		await synthesize({ text: "t", voiceId: "v1" });
		const rows = store.db.select().from(ttsSynthCache).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.provider).toBe("fake-tts");
		expect(rows[0]?.model).toBe("fake-tts-1");
		expect(rows[0]?.voice).toBe("v1");
	});
});
