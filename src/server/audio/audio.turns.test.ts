import { deriveTurns } from "./audio.turns.ts";
import type { VadSegment } from "./audio.types.ts";
import { describe, expect, it } from "bun:test";

const seg = (startMs: number, endMs: number): VadSegment => ({ startMs, endMs });

describe("deriveTurns", () => {
	it("returns no turns when both channels are silent", () => {
		expect(deriveTurns([], [])).toEqual([]);
	});

	it("produces a single turn for one-sided speech", () => {
		const turns = deriveTurns([seg(0, 1000)], []);
		expect(turns).toEqual([
			{
				idx: 0,
				role: "user",
				turnStartMs: 0,
				turnEndMs: 1000,
				voiceStartMs: 0,
				voiceEndMs: 1000,
			},
		]);
	});

	it("alternates roles into successive turns", () => {
		const turns = deriveTurns([seg(0, 1000), seg(2500, 3000)], [seg(1000, 2500)]);
		expect(turns.length).toBe(3);
		expect(turns[0]?.role).toBe("user");
		expect(turns[1]?.role).toBe("agent");
		expect(turns[2]?.role).toBe("user");
		expect(turns[0]?.turnStartMs).toBe(0);
		expect(turns[1]?.turnStartMs).toBe(1000);
		expect(turns[2]?.turnStartMs).toBe(2500);
		expect(turns[0]?.voiceStartMs).toBe(0);
		expect(turns[0]?.voiceEndMs).toBe(1000);
		expect(turns[2]?.voiceStartMs).toBe(2500);
		expect(turns[2]?.voiceEndMs).toBe(3000);
	});

	it("groups consecutive same-role segments into one turn", () => {
		const turns = deriveTurns([seg(0, 500), seg(700, 1200)], [seg(1500, 2000)]);
		expect(turns.length).toBe(2);
		expect(turns[0]?.role).toBe("user");
		expect(turns[0]?.voiceStartMs).toBe(0);
		expect(turns[0]?.voiceEndMs).toBe(1200);
	});

	it("assigns sequential idx starting at 0", () => {
		const turns = deriveTurns(
			[seg(0, 100), seg(300, 400), seg(600, 700)],
			[seg(100, 200), seg(400, 500)],
		);
		expect(turns.map((t) => t.idx)).toEqual([0, 1, 2, 3, 4]);
	});

	it("keeps turnStartMs at the other side's tail when speech doesn't overlap", () => {
		// Non-overlap guard: agent turn starts exactly where the user stopped.
		const turns = deriveTurns([seg(0, 1000)], [seg(1000, 2500)]);
		expect(turns[1]?.turnStartMs).toBe(1000);
		expect(turns[1]?.voiceStartMs).toBe(1000);
	});

	it("clamps an interrupting user turn's start to its own voice onset", () => {
		// User barges in at 4000ms, 300ms before the agent (right) stops at 4300.
		const turns = deriveTurns([seg(0, 1500), seg(4000, 5200)], [seg(2000, 4300), seg(5700, 7500)]);
		expect(turns.map((t) => t.role)).toEqual(["user", "agent", "user", "agent"]);
		expect(turns[1]?.voiceEndMs).toBe(4300);
		// Without the clamp turnStartMs would be 4300 (the agent's tail), landing
		// after the user's 4000 onset. The interrupting turn owns from 4000.
		expect(turns[2]?.turnStartMs).toBe(4000);
		expect(turns[2]?.voiceStartMs).toBe(4000);
	});

	it("clamps an agent interjection that talks over the user", () => {
		// Agent cuts into the user's single 0..3000 utterance at 1500..2500.
		const turns = deriveTurns([seg(0, 3000)], [seg(1500, 2500)]);
		expect(turns[1]?.role).toBe("agent");
		expect(turns[1]?.turnStartMs).toBe(1500);
		expect(turns[1]?.voiceStartMs).toBe(1500);
	});
});
