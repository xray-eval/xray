import type { StereoWav } from "./audio.types.ts";

/**
 * Slice a mono PCM channel out of a stereo recording, bounded by a
 * millisecond range. User turns → left channel, agent turns → right
 * channel — the upload contract for `/v1/replays/:id/audio` is L=user,
 * R=agent (wall-clock aligned).
 *
 * Range is half-open: `[startMs, endMs)`. Returns an empty Int16Array
 * when the range collapses or falls entirely outside the recording —
 * the caller treats an empty slice as a transcription input that the
 * provider will return an empty transcript for.
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
