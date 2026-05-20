import { runVadOnChannel } from "./audio.vad.ts";
import { describe, expect, it } from "bun:test";

const SAMPLE_RATE = 16_000;

/** Synthesize int16 PCM: alternating silent and loud blocks. */
function makeAlternating(blocks: { durationMs: number; voiced: boolean }[]): Int16Array {
	const totalSamples = blocks.reduce(
		(sum, b) => sum + Math.floor((SAMPLE_RATE * b.durationMs) / 1000),
		0,
	);
	const pcm = new Int16Array(totalSamples);
	let cursor = 0;
	for (const block of blocks) {
		const samples = Math.floor((SAMPLE_RATE * block.durationMs) / 1000);
		if (block.voiced) {
			// 200 Hz sine at moderate amplitude — lands inside the default ZCR window.
			for (let i = 0; i < samples; i++) {
				pcm[cursor + i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * 15_000);
			}
		}
		cursor += samples;
	}
	return pcm;
}

describe("runVadOnChannel", () => {
	it("returns an empty array for all-silent PCM", () => {
		const pcm = new Int16Array(SAMPLE_RATE);
		expect(runVadOnChannel(pcm, SAMPLE_RATE)).toEqual([]);
	});

	it("detects a single voiced run after a silent prefix", () => {
		const pcm = makeAlternating([
			{ durationMs: 200, voiced: false },
			{ durationMs: 600, voiced: true },
			{ durationMs: 200, voiced: false },
		]);
		const segments = runVadOnChannel(pcm, SAMPLE_RATE);
		expect(segments.length).toBe(1);
		const seg = segments[0];
		if (seg === undefined) throw new Error("missing");
		expect(seg.startMs).toBeGreaterThanOrEqual(150);
		expect(seg.startMs).toBeLessThanOrEqual(250);
		expect(seg.endMs).toBeGreaterThanOrEqual(750);
		expect(seg.endMs).toBeLessThanOrEqual(850);
	});

	it("merges voiced runs separated by ≤ mergeGapMs", () => {
		const pcm = makeAlternating([
			{ durationMs: 200, voiced: true },
			{ durationMs: 100, voiced: false }, // gap under the default 200ms
			{ durationMs: 200, voiced: true },
		]);
		const segments = runVadOnChannel(pcm, SAMPLE_RATE);
		expect(segments.length).toBe(1);
	});

	it("does not merge voiced runs separated by > mergeGapMs", () => {
		const pcm = makeAlternating([
			{ durationMs: 200, voiced: true },
			{ durationMs: 500, voiced: false }, // gap above the default 200ms
			{ durationMs: 200, voiced: true },
		]);
		const segments = runVadOnChannel(pcm, SAMPLE_RATE);
		expect(segments.length).toBe(2);
	});

	it("discards segments shorter than minSegmentMs", () => {
		const pcm = makeAlternating([
			{ durationMs: 30, voiced: true }, // single frame, below 80ms floor
			{ durationMs: 500, voiced: false },
		]);
		const segments = runVadOnChannel(pcm, SAMPLE_RATE);
		expect(segments).toEqual([]);
	});

	it("respects an explicit lower energy threshold", () => {
		const quietPcm = new Int16Array(SAMPLE_RATE);
		for (let i = 0; i < SAMPLE_RATE; i++) {
			quietPcm[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * 500);
		}
		const defaultRun = runVadOnChannel(quietPcm, SAMPLE_RATE);
		const sensitiveRun = runVadOnChannel(quietPcm, SAMPLE_RATE, { energyThreshold: 1_000 });
		expect(defaultRun.length).toBe(0);
		expect(sensitiveRun.length).toBeGreaterThan(0);
	});
});
