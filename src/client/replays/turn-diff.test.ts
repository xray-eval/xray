import type { ReplayTurnResponse } from "../api/api.types.ts";
import { diffTurns } from "./turn-diff.ts";
import { describe, expect, it } from "bun:test";

function turn(overrides: Partial<ReplayTurnResponse> & { idx: number }): ReplayTurnResponse {
	return {
		idx: overrides.idx,
		role: overrides.role ?? "user",
		turn_start_ms: overrides.turn_start_ms ?? 0,
		turn_end_ms: overrides.turn_end_ms ?? 1000,
		voice_start_ms: overrides.voice_start_ms ?? 100,
		voice_end_ms: overrides.voice_end_ms ?? 900,
	};
}

describe("diffTurns", () => {
	it("aligns turns by idx and flags no diffs when both replays match", () => {
		const rows = diffTurns([
			[turn({ idx: 0, role: "user" }), turn({ idx: 1, role: "agent" })],
			[turn({ idx: 0, role: "user" }), turn({ idx: 1, role: "agent" })],
		]);

		expect(rows.map((r) => r.idx)).toEqual([0, 1]);
		for (const row of rows) {
			for (const cell of row.cells) {
				expect(cell.present).toBe(true);
				expect(cell.differsFromBaseline).toBe(false);
			}
		}
	});

	it("highlights a single turn whose voice range differs", () => {
		const rows = diffTurns([
			[
				turn({ idx: 0, role: "user" }),
				turn({ idx: 1, role: "agent", voice_start_ms: 1500, voice_end_ms: 3000 }),
			],
			[
				turn({ idx: 0, role: "user" }),
				turn({ idx: 1, role: "agent", voice_start_ms: 1500, voice_end_ms: 5200 }),
			],
		]);

		const row0 = rows.find((r) => r.idx === 0);
		const row1 = rows.find((r) => r.idx === 1);
		expect(row0?.cells.every((c) => !c.differsFromBaseline)).toBe(true);
		expect(row1?.cells[0]?.differsFromBaseline).toBe(false);
		expect(row1?.cells[1]?.differsFromBaseline).toBe(true);
	});

	it("highlights cells where a turn is absent at an idx the baseline has", () => {
		const rows = diffTurns([
			[turn({ idx: 0 }), turn({ idx: 1, role: "agent" })],
			[turn({ idx: 0 })],
		]);

		const row1 = rows.find((r) => r.idx === 1);
		expect(row1?.cells[0]?.present).toBe(true);
		expect(row1?.cells[0]?.differsFromBaseline).toBe(false);
		expect(row1?.cells[1]?.present).toBe(false);
		expect(row1?.cells[1]?.differsFromBaseline).toBe(true);
	});

	it("flags a role mismatch at the same idx", () => {
		const rows = diffTurns([[turn({ idx: 0, role: "user" })], [turn({ idx: 0, role: "agent" })]]);

		const row = rows[0];
		expect(row?.cells[0]?.differsFromBaseline).toBe(false);
		expect(row?.cells[1]?.differsFromBaseline).toBe(true);
	});

	it("returns idxs in ascending order even when inputs are unsorted", () => {
		const rows = diffTurns([[turn({ idx: 2 }), turn({ idx: 0 })], [turn({ idx: 1 })]]);
		expect(rows.map((r) => r.idx)).toEqual([0, 1, 2]);
	});
});
