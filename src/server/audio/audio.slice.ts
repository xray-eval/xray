import type { StereoWav } from "./audio.types.ts";

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
