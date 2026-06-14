import type { TurnWindow } from "./timeline.ts";
import {
	audioOffsetMs,
	clampedTurnWindows,
	offsetInTurnWindow,
	rowsInTurnWindow,
} from "./timeline.ts";
import { describe, expect, it } from "bun:test";

// Authentic numbers from snapshot/xray.db replay 7b8e2770… :
//   replays.started_at (WRONG origin)      = 14:31:28.688
//   recording t=0 (first xray.turn span)   = 14:31:31.023   ← correct origin
// The 2335 ms gap between them is the bug this slice exists to kill.
const RECORDING_T0 = "2026-05-26T14:31:31.023Z";
const ROW_CREATION = "2026-05-26T14:31:28.688Z"; // replays.started_at — must NOT be used as origin

describe("audioOffsetMs", () => {
	it("measures the offset from the recording origin, not row creation", () => {
		// A span emitted 4000 ms into the recording.
		const span = "2026-05-26T14:31:35.023Z";
		expect(audioOffsetMs(span, RECORDING_T0)).toBe(4000);
		// Using the row-creation time as origin would inflate it by the 2335 ms
		// gap — the exact bug. Documented here so the regression is legible.
		expect(audioOffsetMs(span, ROW_CREATION)).toBe(6335);
	});

	it("returns null when either timestamp is missing", () => {
		expect(audioOffsetMs(null, RECORDING_T0)).toBeNull();
		expect(audioOffsetMs("2026-05-26T14:31:35.023Z", null)).toBeNull();
		expect(audioOffsetMs(null, null)).toBeNull();
	});

	it("returns null when a timestamp is unparseable", () => {
		expect(audioOffsetMs("not-a-date", RECORDING_T0)).toBeNull();
		expect(audioOffsetMs("2026-05-26T14:31:35.023Z", "garbage")).toBeNull();
	});

	it("can be negative for a span emitted before the recording started", () => {
		expect(audioOffsetMs("2026-05-26T14:31:30.523Z", RECORDING_T0)).toBe(-500);
	});
});

// Snapshot-derived tiling: t0 agent, t1 user, t2 agent. turnStart_N == voiceEnd_{N-1}.
const T0: TurnWindow = { turnStartMs: 0, turnEndMs: 2190 };
const T1: TurnWindow = { turnStartMs: 2190, turnEndMs: 4680 };
const T2: TurnWindow = { turnStartMs: 4680, turnEndMs: 11070 };

describe("offsetInTurnWindow", () => {
	it("includes the start, excludes the end (half-open)", () => {
		expect(offsetInTurnWindow(2190, T1)).toBe(true);
		expect(offsetInTurnWindow(4680, T1)).toBe(false); // belongs to T2
		expect(offsetInTurnWindow(4680, T2)).toBe(true);
	});

	it("tiles: every offset belongs to exactly one turn", () => {
		const turns = [T0, T1, T2];
		for (const offset of [0, 100, 2189, 2190, 4679, 4680, 11069]) {
			expect(turns.filter((t) => offsetInTurnWindow(offset, t)).length).toBe(1);
		}
	});
});

describe("clampedTurnWindows", () => {
	it("tiles strictly-interleaved turns: start_N = end_{N-1}, no gaps", () => {
		// Three turns whose voice ends are already monotonic: 2190, 4680, 11070.
		const windows = clampedTurnWindows([2190, 4680, 11070]);
		expect(windows).toEqual([
			{ turnStartMs: 0, turnEndMs: 2190 },
			{ turnStartMs: 2190, turnEndMs: 4680 },
			{ turnStartMs: 4680, turnEndMs: 11070 },
		]);
	});

	it("collapses an inverted window and never overlaps under barge-in", () => {
		// Agent voiceEnd 5000, user (barged-in) voiceEnd 3500, agent resumes 8000.
		// Raw windows would be [0,5000), [5000,3500) (inverted!), [3500,8000)
		// (overlapping the first). The monotonic cursor fixes both.
		const windows = clampedTurnWindows([5000, 3500, 8000]);
		expect(windows).toEqual([
			{ turnStartMs: 0, turnEndMs: 5000 },
			{ turnStartMs: 5000, turnEndMs: 5000 }, // empty — fully barged over
			{ turnStartMs: 5000, turnEndMs: 8000 },
		]);
		// A call at offset 4200 (fired during agent turn 0) lands in exactly ONE
		// window — turn 0 — not also turn 2 as the raw overlap would allow.
		const hits = windows.filter((w) => offsetInTurnWindow(4200, w));
		expect(hits).toEqual([{ turnStartMs: 0, turnEndMs: 5000 }]);
	});

	it("every offset belongs to exactly one clamped window", () => {
		const windows = clampedTurnWindows([5000, 3500, 8000]);
		for (const offset of [0, 4200, 4999, 5000, 6000, 7999]) {
			expect(windows.filter((w) => offsetInTurnWindow(offset, w)).length).toBe(1);
		}
	});

	it("returns [] for no turns", () => {
		expect(clampedTurnWindows([])).toEqual([]);
	});
});

describe("rowsInTurnWindow", () => {
	const rows = [
		{ id: "prep-t2", startedAt: "2026-05-26T14:31:35.023Z" }, // offset 4000 → T1
		{ id: "voice-t2", startedAt: "2026-05-26T14:31:37.265Z" }, // offset 6242 → T2
		{ id: "no-ts", startedAt: null },
	];

	it("selects only rows whose offset lands in the window", () => {
		expect(rowsInTurnWindow(rows, T2, RECORDING_T0).map((r) => r.id)).toEqual(["voice-t2"]);
		expect(rowsInTurnWindow(rows, T1, RECORDING_T0).map((r) => r.id)).toEqual(["prep-t2"]);
	});

	it("flags a mistimed call: with the correct origin a 4000ms call is NOT in the agent turn T2", () => {
		// This is the regression. With the buggy origin (ROW_CREATION) the same
		// row maps to offset 6335 and would be wrongly counted into T2.
		expect(rowsInTurnWindow(rows, T2, RECORDING_T0).map((r) => r.id)).not.toContain("prep-t2");
		expect(rowsInTurnWindow(rows, T2, ROW_CREATION).map((r) => r.id)).toContain("prep-t2");
	});

	it("drops every row when there is no recording anchor", () => {
		expect(rowsInTurnWindow(rows, T2, null)).toEqual([]);
	});
});
