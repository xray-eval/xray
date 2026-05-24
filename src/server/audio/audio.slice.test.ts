import { sliceTurnAudio } from "./audio.slice.ts";
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
		const stereo = makeStereo(1000, 1000); // 1 second @ 1kHz
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
