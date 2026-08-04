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
		// Each handoff carries 600ms of the other party's speech, over the 500ms
		// floor, so every alternation is a real turn boundary.
		const turns = deriveTurns(
			[seg(0, 1000), seg(1600, 2600), seg(3200, 4200)],
			[seg(1000, 1600), seg(2600, 3200)],
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

	describe("floor handoff", () => {
		// Real segments from replay 6036f881, where the agent paused mid-answer and
		// resumed at the exact millisecond the user barged in (21210). Sorting the
		// merged segment list by start time put the user first, so the agent's own
		// tail opened a new turn and the interrupted turn ended 1.5s before the
		// barge-in — `yielded_within_ms` reported "no interruption landed" for an
		// agent that in fact stopped 330ms after being cut off. Nobody spoke during
		// the agent's pause, so it never gave up the floor: one turn.
		it("keeps one utterance in one turn when nobody else took the floor during its pause", () => {
			const turns = deriveTurns(
				[seg(14370, 17340), seg(21210, 21870), seg(22500, 23490), seg(23940, 25080)],
				[seg(2640, 11940), seg(19140, 19680), seg(21210, 21540), seg(27120, 52530)],
			);
			const interrupted = turns.find((t) => t.role === "agent" && t.voiceStartMs === 19140);
			expect(interrupted?.voiceEndMs).toBe(21540);
			expect(turns.filter((t) => t.role === "agent" && t.voiceStartMs === 21210)).toEqual([]);
		});

		// The other half of the rule: gap length must NOT decide this. The agent's
		// pause above is 1530ms, while the snapshot fixture's genuine turn boundary
		// below is a 1380ms gap — the gap that must merge is LONGER than the gap
		// that must not, so only "did the other party hold the floor" can separate
		// them.
		it("splits into separate turns when the other party held the floor in between", () => {
			const turns = deriveTurns(
				[seg(0, 1800), seg(4290, 5520)],
				[seg(2280, 4620), seg(6000, 8010)],
			);
			expect(turns.map((t) => t.role)).toEqual(["user", "agent", "user", "agent"]);
			expect(turns[1]?.voiceEndMs).toBe(4620);
			expect(turns[3]?.voiceStartMs).toBe(6000);
		});

		// The outcome must not depend on which channel's segment sorts first when
		// the agent's resumption and the user's onset land on the same millisecond
		// — that tie was decided by concatenation order feeding a stable sort.
		it("derives the same turns whether the tail lands before, on, or after the barge-in", () => {
			const structure = (agentTailStartMs: number) =>
				deriveTurns(
					[seg(14370, 17340), seg(21210, 21870), seg(22500, 23490), seg(23940, 25080)],
					[seg(2640, 11940), seg(19140, 19680), seg(agentTailStartMs, 21540), seg(27120, 52530)],
				).map((t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`);
			expect(structure(21210)).toEqual(structure(21209));
			expect(structure(21210)).toEqual(structure(21211));
		});

		// The mirror of the onset tie, on the other edge: the user's line ends right
		// around the moment the agent's voice stops. Whether it ends a frame before,
		// exactly at, or a frame after must not change the reading — the user
		// finished, 1.4s of silence followed, and the agent's next words answer them.
		// Merging instead bills the agent ~4s of yield for a 620ms yield.
		it("reads a completed barge-in the same way on either side of the yield instant", () => {
			const structure = (userEndMs: number) =>
				deriveTurns([seg(0, 1800), seg(4000, userEndMs)], [seg(2280, 4620), seg(6000, 8010)]).map(
					(t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`,
				);
			const expected = ["user 0-1800", "agent 2280-4620", "user 4000-4620", "agent 6000-8010"];
			expect(structure(4620)).toEqual(expected);
			expect(structure(4619)).toEqual([
				"user 0-1800",
				"agent 2280-4620",
				"user 4000-4619",
				"agent 6000-8010",
			]);
			expect(structure(4621)).toEqual([
				"user 0-1800",
				"agent 2280-4620",
				"user 4000-4621",
				"agent 6000-8010",
			]);
		});

		// Issue #126's worked example: one agent answer that VAD split at a sentence
		// pause, with the user talking across the split.
		it("keeps an utterance whole when the other party interrupted across its pause", () => {
			const turns = deriveTurns([seg(12000, 13000)], [seg(10000, 12500), seg(12800, 20000)]);
			const agentTurns = turns.filter((t) => t.role === "agent");
			expect(agentTurns.length).toBe(1);
			expect(agentTurns[0]?.voiceStartMs).toBe(10000);
			expect(agentTurns[0]?.voiceEndMs).toBe(20000);
		});

		// Replay 2a8fd70b's real segments, as this VAD reads them: an agent that
		// talked straight through the user's question, pausing only in beats too
		// short to hand over the floor. Keeping that as ONE agent turn is what makes
		// its ~9.8s failure to yield visible at all — split into fragments, no agent
		// turn read as interrupted and the failure vanished from the report.
		it("keeps talking-over-the-user as one turn for the speaker who never yielded", () => {
			const turns = deriveTurns(
				[seg(2250, 2790), seg(3090, 5760)],
				[seg(1410, 1890), seg(2490, 3150), seg(3360, 6300), seg(6990, 10350), seg(11130, 12060)],
			);
			expect(turns.map((t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`)).toEqual([
				"agent 1410-12060",
				"user 2250-5760",
			]);
		});

		// A short reply is still a reply. "Ja." can be under 500ms of speech, and if
		// that failed to close the agent's turn the two answers around it would
		// merge, the recording would come out one turn short of the script, and the
		// whole replay would fail spec_vad_mismatch instead of being evaluated.
		it("splits on a complete short utterance from the other party", () => {
			const turns = deriveTurns([seg(3500, 3900)], [seg(0, 3000), seg(4400, 8000)]);
			expect(turns.map((t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`)).toEqual([
				"agent 0-3000",
				"user 3500-3900",
				"agent 4400-8000",
			]);
		});

		// The snapshot's geometry with the barge-in line 430ms shorter: the agent
		// yields 330ms after being cut into, the user's utterance ends 470ms later,
		// and the agent answers at 6000. Only 470ms of user speech lands inside the
		// agent's pause — under the overlap floor — so a floor-only rule merges the
		// answer into the interrupted turn and reports a 3720ms yield, failing an
		// agent that actually yielded in 330ms. A completed utterance settles it:
		// speech that ENDED before we resumed cannot still be interrupting us.
		it("splits when a full-length utterance ended before the speaker resumed", () => {
			const turns = deriveTurns(
				[seg(0, 1800), seg(4290, 5090)],
				[seg(2280, 4620), seg(6000, 8010)],
			);
			expect(turns.map((t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`)).toEqual([
				"user 0-1800",
				"agent 2280-4620",
				"user 4290-5090",
				"agent 6000-8010",
			]);
		});

		// Guards MIN_UTTERANCE_MS from below. A 150ms blip in a quiet pause is a
		// fragment, not a turn: without the floor it splits one answer in two,
		// which scatters that turn's transcript and assertions across the halves.
		it("ignores a sub-utterance blip in an otherwise quiet pause", () => {
			const turns = deriveTurns([seg(1400, 1550)], [seg(0, 1000), seg(2000, 3000)]);
			expect(turns.map((t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`)).toEqual([
				"agent 0-3000",
				"user 1400-1550",
			]);
		});

		// Pins the one edge the rule genuinely tests exactly: whether the other
		// party is still speaking at the instant we resume. A frame of double-talk
		// there flips the reading, and both sides are defensible — they finished
		// before we resumed, versus they were still going — so this test exists to
		// stop a refactor moving the boundary silently, not because one answer is
		// wrong. Held time is in the [200, 500) band, where the branch decides.
		it("switches branch on double-talk at the resumption instant", () => {
			const structure = (userEndMs: number) =>
				deriveTurns([seg(1700, userEndMs)], [seg(0, 1000), seg(2000, 3000)]).map(
					(t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`,
				);
			// Ends exactly as we resume → they finished, so our resumption replies.
			expect(structure(2000)).toEqual(["agent 0-1000", "user 1700-2000", "agent 2000-3000"]);
			// Still going by one millisecond → genuine overlap, and 300ms of held
			// floor is under FLOOR_HANDOFF_MS, so the utterance stays whole.
			expect(structure(2001)).toEqual(["agent 0-3000", "user 1700-2001"]);
		});

		// The mirror case: the other party's utterance ENDED inside the pause, so
		// the floor changed hands and the resumption is a fresh reply.
		it("splits when the other party finished speaking inside the pause", () => {
			const turns = deriveTurns([seg(12900, 14000)], [seg(10000, 13200), seg(14800, 16000)]);
			expect(turns.map((t) => `${t.role} ${t.voiceStartMs}-${t.voiceEndMs}`)).toEqual([
				"agent 10000-13200",
				"user 12900-14000",
				"agent 14800-16000",
			]);
		});
	});
});
