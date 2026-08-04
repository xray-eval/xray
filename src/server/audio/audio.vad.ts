import type { VadConfig, VadSegment } from "./audio.types.ts";

const DEFAULT_FRAME_DURATION_MS = 30;
// 2.5e5 mean energy = 500 int16 RMS ≈ -36 dBFS — deliberately the same boundary
// the SDK driver uses to tell agent speech from the comfort noise a track carries
// while the agent is thinking (`_SPEECH_RMS_FLOOR` in
// `sdk/python/src/xray/runtime/livekit.py`). Driver and server disagreeing on
// what counts as speech is how a barge-in the driver timed against real audio
// became invisible to the analyzer.
//
// Calibrated against two real azure-openai voice-to-voice recordings, not just
// the sine fixtures: agent speech there measures 846-1897 RMS (7.2e5-3.6e6 frame
// energy) while the loudest non-speech frame measured 1.07e5. The previous 5e6
// was tuned on 15_000-amplitude sines alone and missed ~88% of one recording's
// speech frames, which fragmented turns and broke barge-in attribution.
const DEFAULT_ENERGY_THRESHOLD = 250_000;
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
