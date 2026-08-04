import { buildWav, scriptFor } from "./seed-snapshot.audio.ts";
import type { ScriptedTurn } from "./seed-snapshot.types.ts";
import { describe, expect, it } from "bun:test";

const SAMPLE_RATE = 48_000;

const SCRIPT: readonly ScriptedTurn[] = [
	{ role: "user", startMs: 0, endMs: 1800, amplitude: 6_000, transcript: "Book me a flight." },
	{ role: "agent", startMs: 2300, endMs: 4600, amplitude: 9_000, transcript: "Booking it." },
	{ role: "user", startMs: 4300, endMs: 5500, amplitude: 12_000, transcript: "No, wait." },
	{ role: "agent", startMs: 6000, endMs: 8000, amplitude: 15_000, transcript: "Got it." },
];

function peakBetween(channel: Int16Array, startMs: number, endMs: number): number {
	let peak = 0;
	const from = Math.round((startMs / 1000) * SAMPLE_RATE);
	const to = Math.round((endMs / 1000) * SAMPLE_RATE);
	for (let i = from; i < to; i++) {
		const sample = channel[i] ?? 0;
		if (Math.abs(sample) > peak) peak = Math.abs(sample);
	}
	return peak;
}

describe("scriptFor", () => {
	// The whole `agentDelayMs` spread rests on this: shifting only the START of an
	// agent turn moves `agent_response_ms` while leaving the barge-in overlap —
	// and therefore `yield_ms` and `yielded_within_ms` — untouched.
	it("shifts an agent turn's start and never its end", () => {
		const shifted = scriptFor(SCRIPT, 350);
		expect(shifted.map((t) => t.startMs)).toEqual([0, 2650, 4300, 6350]);
		expect(shifted.map((t) => t.endMs)).toEqual(SCRIPT.map((t) => t.endMs));
	});

	it("leaves user turns where they are, so the barge-in overlap is preserved", () => {
		const shifted = scriptFor(SCRIPT, -250);
		const users = shifted.filter((t) => t.role === "user");
		expect(users).toEqual(SCRIPT.filter((t) => t.role === "user"));
		// Read off the shifted script, not off the literals: the barge-in only
		// exists while the interrupting user turn still starts before the agent
		// turn it talks over ends, and that's what a moved end would break.
		const agentBeingInterrupted = shifted[1];
		const interruptingUser = shifted[2];
		expect(interruptingUser?.startMs).toBeLessThan(agentBeingInterrupted?.endMs ?? 0);
	});

	it("returns the same array reference when there is no delay", () => {
		expect(scriptFor(SCRIPT, 0)).toBe(SCRIPT);
	});
});

describe("buildWav", () => {
	it("sizes both channels from the recording length", () => {
		const wav = buildWav(SCRIPT, 8200);
		expect(wav.sampleRate).toBe(SAMPLE_RATE);
		expect(wav.bitsPerSample).toBe(16);
		expect(wav.left.length).toBe(Math.round((8200 / 1000) * SAMPLE_RATE));
		expect(wav.right.length).toBe(wav.left.length);
	});

	it("puts the user on the left channel and the agent on the right", () => {
		const wav = buildWav(SCRIPT, 8200);
		expect(peakBetween(wav.left, 0, 1800)).toBeGreaterThan(0);
		expect(peakBetween(wav.right, 0, 1800)).toBe(0);
		expect(peakBetween(wav.right, 2300, 4600)).toBeGreaterThan(0);
	});

	// The amplitude is the marker the seeder's stand-in transcription provider
	// reads back to recover a turn's line, so each turn's slice has to carry its
	// own amplitude and the gaps have to be silent.
	it("writes each turn at its own amplitude, with silence between turns", () => {
		const wav = buildWav(SCRIPT, 8200);
		expect(peakBetween(wav.left, 0, 1800)).toBeCloseTo(6_000, -2);
		expect(peakBetween(wav.right, 2300, 4600)).toBeCloseTo(9_000, -2);
		expect(peakBetween(wav.left, 4300, 5500)).toBeCloseTo(12_000, -2);
		expect(peakBetween(wav.right, 6000, 8000)).toBeCloseTo(15_000, -2);
		expect(peakBetween(wav.right, 4700, 5900)).toBe(0);
	});

	it("overlaps the barge-in on both channels at once", () => {
		const wav = buildWav(SCRIPT, 8200);
		expect(peakBetween(wav.left, 4300, 4600)).toBeGreaterThan(0);
		expect(peakBetween(wav.right, 4300, 4600)).toBeGreaterThan(0);
	});

	it("is deterministic — the same script twice yields the same samples", () => {
		const a = buildWav(SCRIPT, 8200);
		const b = buildWav(SCRIPT, 8200);
		expect(Array.from(a.left)).toEqual(Array.from(b.left));
		expect(Array.from(a.right)).toEqual(Array.from(b.right));
	});
});
