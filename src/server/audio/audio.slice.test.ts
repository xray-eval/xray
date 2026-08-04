import { sliceTurnAudio, trimTrailingSilence } from "./audio.slice.ts";
import type { StereoWav } from "./audio.types.ts";
import { describe, expect, it } from "bun:test";

function makeStereo(sampleRate: number, samples: number): StereoWav {
	const left = new Int16Array(samples);
	const right = new Int16Array(samples);
	for (let i = 0; i < samples; i++) {
		left[i] = i;
		right[i] = -i;
	}
	return { sampleRate, bitsPerSample: 16, left, right };
}

describe("sliceTurnAudio", () => {
	it("returns the user channel for role 'user'", () => {
		const stereo = makeStereo(1000, 1000);
		const slice = sliceTurnAudio(stereo, "user", 100, 200);
		expect(slice.length).toBe(100);
		expect(slice[0]).toBe(100);
		expect(slice[99]).toBe(199);
	});

	it("returns the agent channel for role 'agent' (mirrored sign)", () => {
		const stereo = makeStereo(1000, 1000);
		const slice = sliceTurnAudio(stereo, "agent", 100, 200);
		expect(slice[0]).toBe(-100);
		expect(slice[99]).toBe(-199);
	});

	it("clamps to recording bounds", () => {
		const stereo = makeStereo(1000, 1000);
		const slice = sliceTurnAudio(stereo, "user", 900, 5000);
		expect(slice.length).toBe(100);
		expect(slice[0]).toBe(900);
		expect(slice[99]).toBe(999);
	});

	it("returns an empty slice when range collapses", () => {
		const stereo = makeStereo(1000, 1000);
		expect(sliceTurnAudio(stereo, "user", 500, 500).length).toBe(0);
		expect(sliceTurnAudio(stereo, "user", 600, 500).length).toBe(0);
	});

	it("returns an empty slice when the range is entirely past the recording", () => {
		const stereo = makeStereo(1000, 1000);
		expect(sliceTurnAudio(stereo, "user", 2000, 3000).length).toBe(0);
	});

	it("converts millisecond bounds at 48kHz correctly", () => {
		// 48000 samples per second → 48 samples per ms
		const stereo = makeStereo(48_000, 48_000); // 1 second
		const slice = sliceTurnAudio(stereo, "user", 100, 200);
		// 100ms → sample 4800; 200ms → sample 9600 → 4800 samples
		expect(slice.length).toBe(4800);
		expect(slice[0]).toBe(4800);
	});
});

describe("trimTrailingSilence", () => {
	const SAMPLE_RATE = 48_000;

	function withTone(toneMs: number, silenceMs: number, amplitude: number): StereoWav {
		const toneSamples = Math.floor((SAMPLE_RATE * toneMs) / 1000);
		const total = toneSamples + Math.floor((SAMPLE_RATE * silenceMs) / 1000);
		const left = new Int16Array(total);
		const right = new Int16Array(total);
		for (let i = 0; i < toneSamples; i++) {
			right[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * amplitude);
		}
		return { sampleRate: SAMPLE_RATE, bitsPerSample: 16, left, right };
	}

	function trimmedMs(stereo: StereoWav, channel: "user" | "agent"): number {
		const pcm = sliceTurnAudio(stereo, channel, 0, 1_000_000);
		return (trimTrailingSilence(pcm, stereo.sampleRate).length / stereo.sampleRate) * 1000;
	}

	it("drops a long silent tail, keeping a short pad", () => {
		// 1s of tone then 40s of silence: the 300ms pad is the only silence kept,
		// give or take the 30ms frame the tone ends inside.
		const kept = trimmedMs(withTone(1000, 40_000, 15_000), "agent");
		expect(kept).toBeGreaterThanOrEqual(1300);
		expect(kept).toBeLessThanOrEqual(1340);
	});

	it("returns nothing for a channel that never carries audio", () => {
		expect(trimmedMs(withTone(1000, 1000, 15_000), "user")).toBe(0);
	});

	it("leaves a slice that runs to its last sample untouched", () => {
		const stereo = withTone(1000, 0, 15_000);
		const pcm = sliceTurnAudio(stereo, "agent", 0, 1_000_000);
		expect(trimTrailingSilence(pcm, stereo.sampleRate).length).toBe(pcm.length);
	});

	it("keeps quiet speech the VAD cannot see", () => {
		// 300 amplitude ⇒ 4.5e4 mean energy: below the 2.5e5 VAD speech threshold,
		// so VAD marks no segment — but this is real speech and transcription must
		// still receive it, which is why the floor sits an order of magnitude lower.
		expect(trimmedMs(withTone(2000, 10_000, 300), "agent")).toBeGreaterThanOrEqual(2000);
	});

	it("treats a near-silent tail as silence", () => {
		// 80 amplitude ⇒ 3.2e3, under the 1e4 floor: a channel decaying to this
		// must not hold the slice open.
		const toneSamples = SAMPLE_RATE;
		const total = toneSamples * 5;
		const left = new Int16Array(total);
		const right = new Int16Array(total);
		for (let i = 0; i < total; i++) {
			const amplitude = i < toneSamples ? 15_000 : 80;
			right[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * amplitude);
		}
		const stereo: StereoWav = { sampleRate: SAMPLE_RATE, bitsPerSample: 16, left, right };
		expect(trimmedMs(stereo, "agent")).toBeLessThanOrEqual(1330);
	});
});
