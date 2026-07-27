import type { VadConfig, VadSegment } from "./audio.types.ts";

const DEFAULT_FRAME_DURATION_MS = 30;
// 5e6 mean energy ≈ 2236 int16 RMS amplitude ≈ -23 dBFS. Calibrated against
// the synthetic test fixtures only (200 Hz sine at amplitude 15000 trips,
// 500-amplitude background doesn't). Real WebRTC + TTS output has not been
// measured against this; mis-tuning on real audio is plausible (too strict
// = quiet speech missed; too sensitive = WebRTC comfort noise tripped).
const DEFAULT_ENERGY_THRESHOLD = 5_000_000;
const DEFAULT_MERGE_GAP_MS = 200;
const DEFAULT_MIN_SEGMENT_MS = 80;
const DEFAULT_ZCR_MIN = 0;
const DEFAULT_ZCR_MAX = 0.5;

/**
 * Pure-JS energy + zero-crossing-rate VAD for a single channel of int16 PCM.
 * A frame is voiced iff energy is above threshold AND ZCR is inside
 * [zcrMin, zcrMax] — the ZCR gate cuts wideband noise (high ZCR) and DC
 * offset / clicks (very low ZCR).
 *
 * Accuracy is lower than libfvad / Silero; acceptable for v0 because xray's
 * input is the driver's recorded WebRTC stream (no microphone noise) and the
 * dev's controlled TTS output. Thresholds are calibrated only against
 * synthetic sine fixtures (see audio.vad.test.ts).
 */
export function runVadOnChannel(
	pcm: Int16Array,
	sampleRate: number,
	config: VadConfig = {},
): VadSegment[] {
	const frameDurationMs = config.frameDurationMs ?? DEFAULT_FRAME_DURATION_MS;
	const energyThreshold = config.energyThreshold ?? DEFAULT_ENERGY_THRESHOLD;
	const mergeGapMs = config.mergeGapMs ?? DEFAULT_MERGE_GAP_MS;
	const minSegmentMs = config.minSegmentMs ?? DEFAULT_MIN_SEGMENT_MS;
	const zcrMin = config.zcrMin ?? DEFAULT_ZCR_MIN;
	const zcrMax = config.zcrMax ?? DEFAULT_ZCR_MAX;
	const frameSamples = Math.floor((sampleRate * frameDurationMs) / 1000);
	if (frameSamples === 0) return [];

	const isVoiced: boolean[] = [];
	for (let frameStart = 0; frameStart + frameSamples <= pcm.length; frameStart += frameSamples) {
		let energySum = 0;
		let zeroCrossings = 0;
		let prev = pcm[frameStart] ?? 0;
		for (let i = 0; i < frameSamples; i++) {
			const s = pcm[frameStart + i] ?? 0;
			energySum += s * s;
			if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) zeroCrossings += 1;
			prev = s;
		}
		const meanEnergy = energySum / frameSamples;
		const zcr = zeroCrossings / frameSamples;
		isVoiced.push(meanEnergy > energyThreshold && zcr >= zcrMin && zcr <= zcrMax);
	}

	const segments: VadSegment[] = [];
	let runStart: number | null = null;
	for (let f = 0; f < isVoiced.length; f++) {
		if (isVoiced[f] === true) {
			if (runStart === null) runStart = f;
		} else if (runStart !== null) {
			segments.push({
				startMs: runStart * frameDurationMs,
				endMs: f * frameDurationMs,
			});
			runStart = null;
		}
	}
	if (runStart !== null) {
		segments.push({
			startMs: runStart * frameDurationMs,
			endMs: isVoiced.length * frameDurationMs,
		});
	}

	const merged: VadSegment[] = [];
	for (const seg of segments) {
		const last = merged[merged.length - 1];
		if (last !== undefined && seg.startMs - last.endMs <= mergeGapMs) {
			merged[merged.length - 1] = { startMs: last.startMs, endMs: seg.endMs };
		} else {
			merged.push(seg);
		}
	}

	return merged.filter((s) => s.endMs - s.startMs >= minSegmentMs);
}
