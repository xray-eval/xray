/**
 * Synthesizes the stereo WAV a seeded replay's driver would have uploaded: one
 * sine tone per scripted turn, user on the left channel and agent on the right,
 * so the server's VAD has real speech to find and a real barge-in overlap to
 * measure.
 *
 * Each turn gets a distinct amplitude, which is also the marker the seeder's
 * stand-in transcription provider reads back to recover the turn's line — so
 * amplitudes have to stay unique across every script, not just within one.
 */

import type { StereoWav } from "@/server/audio/audio.types.ts";

import type { ScriptedTurn } from "./seed-snapshot.types.ts";

const SAMPLE_RATE = 48_000;
const TONE_HZ = 200;

/** Agent turns start `agentDelayMs` earlier/later; their ends never move. */
export function scriptFor(
	script: readonly ScriptedTurn[],
	agentDelayMs: number,
): readonly ScriptedTurn[] {
	if (agentDelayMs === 0) return script;
	return script.map((turn) =>
		turn.role === "agent" ? { ...turn, startMs: turn.startMs + agentDelayMs } : turn,
	);
}

export function buildWav(script: readonly ScriptedTurn[], recordingEndMs: number): StereoWav {
	const totalSamples = Math.round((recordingEndMs / 1000) * SAMPLE_RATE);
	const left = new Int16Array(totalSamples);
	const right = new Int16Array(totalSamples);
	for (const turn of script) {
		writeTone(turn.role === "user" ? left : right, turn);
	}
	return { sampleRate: SAMPLE_RATE, bitsPerSample: 16, left, right };
}

function writeTone(channel: Int16Array, turn: ScriptedTurn): void {
	const start = Math.round((turn.startMs / 1000) * SAMPLE_RATE);
	const end = Math.round((turn.endMs / 1000) * SAMPLE_RATE);
	for (let i = start; i < end; i++) {
		channel[i] = Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * turn.amplitude);
	}
}
