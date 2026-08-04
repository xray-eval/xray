import type { StereoWav } from "./audio.types.ts";

const AUDIBLE_FRAME_MS = 30;
/**
 * Mean-square floor for "this frame carries audio at all" — 1e4, i.e. 100 int16
 * RMS. It decides where a recording *stops*, not where speech is, so it must sit
 * far below the VAD speech threshold (2.5e5 in `audio.vad.ts`): audio quieter
 * than the VAD floor is exactly the audio transcription must still receive, and
 * raising this to meet the VAD would truncate the quiet trailing replies the
 * slice extension exists to catch.
 *
 * The consequence of erring low is bounded and deliberate: a channel that idles
 * on comfort noise above 100 RMS simply doesn't get trimmed, which is the
 * behaviour we had before. The case this fixes — a driver waiting out an agent
 * turn that never came — leaves digital silence, measured at ≤17 mean-square.
 */
const AUDIBLE_ENERGY_FLOOR = 10_000;
/** Silence kept after the last audible frame, so a decaying tail isn't clipped. */
const TRIM_PAD_MS = 300;

/**
 * Slice a mono PCM channel out of the stereo recording. User → left, agent →
 * right, matching the `/v1/replays/:id/audio` upload contract (L=user, R=agent).
 * Range is half-open `[startMs, endMs)`; returns an empty Int16Array when the
 * range collapses or falls outside the recording (fed to the transcription
 * provider as an empty-transcript input).
 */
export function sliceTurnAudio(
	stereo: StereoWav,
	channel: "user" | "agent",
	startMs: number,
	endMs: number,
): Int16Array {
	if (endMs <= startMs) return new Int16Array(0);
	const startSample = Math.max(0, Math.floor((startMs * stereo.sampleRate) / 1000));
	const endSample = Math.min(stereo.left.length, Math.ceil((endMs * stereo.sampleRate) / 1000));
	if (endSample <= startSample) return new Int16Array(0);
	const source = channel === "user" ? stereo.left : stereo.right;
	return source.slice(startSample, endSample);
}

/**
 * Drop trailing silence from a slice, keeping `TRIM_PAD_MS` of it so a decaying
 * final consonant isn't clipped. Returns an empty array for an all-silent slice.
 *
 * A transcription window ends at the next onset on the same channel, or at the
 * end of the recording for the last turn — and a recording routinely outlives
 * the conversation inside it. One real replay had the driver wait out an agent
 * turn that never came, so the last two turns were transcribed from 57-second
 * windows that were 80% silence: one came back empty, another came back with a
 * sentence the audio could not contain, and a judge graded that text as if the
 * agent had said it. Trimming the audio rather than the window fixes the
 * interior case too, where a channel that stays quiet between two of its own
 * turns produces an equally padded slice.
 */
export function trimTrailingSilence(pcm: Int16Array, sampleRate: number): Int16Array {
	const frameSamples = Math.floor((sampleRate * AUDIBLE_FRAME_MS) / 1000);
	if (frameSamples === 0) return pcm;
	for (let frameStart = pcm.length - frameSamples; frameStart >= 0; frameStart -= frameSamples) {
		let energySum = 0;
		for (let i = 0; i < frameSamples; i++) {
			const sample = pcm[frameStart + i] ?? 0;
			energySum += sample * sample;
		}
		if (energySum / frameSamples > AUDIBLE_ENERGY_FLOOR) {
			const keep = frameStart + frameSamples + Math.floor((sampleRate * TRIM_PAD_MS) / 1000);
			return keep >= pcm.length ? pcm : pcm.subarray(0, keep);
		}
	}
	return new Int16Array(0);
}
