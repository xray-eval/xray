import { eq } from "drizzle-orm";

import { seedConversation } from "@/server/conversations/conversations.test-utils.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import { replayEvaluations, replayMetrics, replays, replayTurns } from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import type { ReplayTurnRow } from "@/server/store/types.ts";

import { computeMetrics, makeCalculateMetricsProcessor } from "./calculate-metrics.processor.ts";
import { describe, expect, it } from "bun:test";

async function setupReplay(opts: { live?: boolean } = {}): Promise<{
	store: ReturnType<typeof makeTempStore>;
	replayId: string;
	startedAt: string;
}> {
	const store = makeTempStore();
	const { hash } = await seedConversation(store, opts.live ? { live: true } : {});
	const detail = createReplay(store, { conversation_hash: hash });
	// Park the replay in `analyzing` so the processor's WHERE guard hits.
	store.db
		.update(replays)
		.set({ lifecycleState: "analyzing", analysisStep: "transcribe" })
		.where(eq(replays.id, detail.id))
		.run();
	const row = store.db.select().from(replays).where(eq(replays.id, detail.id)).get();
	if (row === undefined) throw new Error("replay row vanished");
	return { store, replayId: detail.id, startedAt: row.startedAt };
}

/** A derived turn row; only the voice window and role drive these metrics. */
function turn(
	idx: number,
	role: "user" | "agent",
	voiceStartMs: number,
	voiceEndMs: number,
): ReplayTurnRow {
	return {
		replayId: "r",
		idx,
		role,
		turnStartMs: voiceStartMs,
		turnEndMs: voiceEndMs,
		voiceStartMs,
		voiceEndMs,
	};
}

describe("computeMetrics (pure)", () => {
	it("returns agentResponseMs = voiceStart - priorUserVoiceEnd for agent turns", () => {
		const rows = computeMetrics("r", [turn(0, "user", 0, 1000), turn(1, "agent", 1300, 2500)]);
		expect(rows[1]?.agentResponseMs).toBe(300);
		expect(rows[0]?.agentResponseMs).toBeNull();
	});

	it("flags interrupted=true when an opposite-role turn starts inside the turn", () => {
		const rows = computeMetrics("r", [turn(0, "agent", 500, 2800), turn(1, "user", 1200, 1900)]);
		expect(rows[0]?.interrupted).toBe(true);
		expect(rows[0]?.interruptionStartMs).toBe(1200);
	});

	// A backchannel is not a barge-in. Without a minimum the shortest thing VAD
	// will emit (80ms) started the yield clock, so an agent that correctly ignored
	// a cough was billed for every remaining second of its own answer.
	it("ignores an opposite-role turn shorter than the barge-in minimum", () => {
		const rows = computeMetrics("r", [turn(0, "agent", 1000, 10_000), turn(1, "user", 2000, 2090)]);
		expect(rows[0]?.interrupted).toBe(false);
		expect(rows[0]?.yieldMs).toBeNull();
	});

	// A barge-in is one thing the caller said, not one thing the VAD emitted.
	// "Wait— stop!" with a beat in the middle arrives as two sub-500ms segments,
	// because VAD only bridges gaps up to its own mergeGapMs. Measuring one segment
	// at a time missed it entirely and `yielded_within_ms` errored with "no
	// interruption landed" on an agent that was plainly cut off — the failure #126
	// was about. Turn derivation groups those segments into this one 950ms turn
	// (see audio.turns.test.ts), so reading turns is what makes the barge-in
	// visible here.
	it("sees a barge-in that VAD split across a pause", () => {
		const rows = computeMetrics("r", [turn(0, "agent", 2280, 4620), turn(1, "user", 4290, 5240)]);
		expect(rows[0]?.interrupted).toBe(true);
		expect(rows[0]?.interruptionStartMs).toBe(4290);
		expect(rows[0]?.yieldMs).toBe(330);
	});

	// The floor measures the interrupting utterance's OWN length, not the part of
	// it that overlaps the turn. Replay 6036f881's numbers: the agent yielded 330ms
	// after a 660ms barge-in, so only 330ms of that line lands inside the turn. An
	// overlap-based floor would reject it and so would fail precisely the agents
	// that yielded fastest — the better the agent, the smaller the overlap.
	it("measures the barge-in minimum against the whole utterance, not the overlap", () => {
		const rows = computeMetrics("r", [
			turn(0, "agent", 19_140, 21_540),
			turn(1, "user", 21_210, 21_870),
		]);
		expect(rows[0]?.interrupted).toBe(true);
		expect(rows[0]?.yieldMs).toBe(330);
	});

	// The floor is on the interrupting speech, not on how far into the turn it
	// lands: a real barge-in that starts late still counts.
	it("counts an opposite-role turn exactly at the minimum", () => {
		const rows = computeMetrics("r", [turn(0, "agent", 1000, 10_000), turn(1, "user", 9000, 9500)]);
		expect(rows[0]?.interrupted).toBe(true);
		expect(rows[0]?.yieldMs).toBe(1000);
	});

	// The window is half-open, and exact adjacency is ordinary on a 30ms VAD grid:
	// one side stops at the millisecond the other starts. That is a clean handoff,
	// not an interruption — treating it as one would report a 0ms yield on turns
	// where nobody talked over anybody.
	it("does not flag a turn whose successor starts exactly as it ends", () => {
		const rows = computeMetrics("r", [turn(0, "user", 0, 1000), turn(1, "agent", 1000, 2500)]);
		expect(rows[0]?.interrupted).toBe(false);
		expect(rows[0]?.yieldMs).toBeNull();
	});

	// Overlapping same-role turns can't come out of `deriveTurns`, but the role
	// filter is worth pinning: an agent's own voice must never read as a barge-in
	// against itself.
	it("interrupted=false when only a same-role turn overlaps", () => {
		const rows = computeMetrics("r", [turn(0, "agent", 500, 1800), turn(1, "agent", 600, 1500)]);
		expect(rows[0]?.interrupted).toBe(false);
	});

	it("yieldMs = voiceEnd - interruptionStart for an interrupted turn, null otherwise", () => {
		// The caller cuts in at 1500; the agent (voiced through 1800) keeps talking
		// 300ms. The agent's next turn then starts at 2000, while the caller is still
		// going — so the caller's turn is itself interrupted, 200ms before it ends.
		// Interruption is symmetric, and both directions are asserted here.
		const rows = computeMetrics("r", [
			turn(0, "agent", 500, 1800),
			turn(1, "user", 1500, 2200),
			turn(2, "agent", 2000, 3000),
		]);
		expect(rows[0]?.yieldMs).toBe(300);
		expect(rows[1]?.interrupted).toBe(true);
		expect(rows[1]?.interruptionStartMs).toBe(2000);
		expect(rows[1]?.yieldMs).toBe(200);
		// The last turn is talked over by nobody after it.
		expect(rows[2]?.interrupted).toBe(false);
		expect(rows[2]?.yieldMs).toBeNull();
	});

	it("uses the EARLIEST qualifying onset, not whichever turn iterates first", () => {
		// Two separate caller turns land inside one long agent turn. yieldMs must run
		// from the first contested moment, not from whichever row comes first in the
		// array — so the later one is listed first here.
		const rows = computeMetrics("r", [
			turn(0, "agent", 500, 4000),
			turn(2, "user", 3000, 3600),
			turn(1, "user", 1200, 1750),
		]);
		expect(rows[0]?.interruptionStartMs).toBe(1200);
		expect(rows[0]?.yieldMs).toBe(2800); // 4000 - 1200
	});
});

describe("makeCalculateMetricsProcessor", () => {
	it("writes replay_metrics rows, transitions to analysis_step='metrics', enqueues evaluate-replay", async () => {
		const { store, replayId } = await setupReplay();
		store.db
			.insert(replayTurns)
			.values([
				{
					replayId,
					idx: 0,
					role: "user",
					turnStartMs: 0,
					turnEndMs: 1000,
					voiceStartMs: 0,
					voiceEndMs: 1000,
				},
				{
					replayId,
					idx: 1,
					role: "agent",
					turnStartMs: 1000,
					turnEndMs: 2500,
					voiceStartMs: 1300,
					voiceEndMs: 2500,
				},
			])
			.run();

		const runner = makeFakeJobRunner();
		const processor = makeCalculateMetricsProcessor(store, makeReplayEvents(), runner);
		const result = await processor({ replayId });

		expect(result.ok).toBe(true);
		const rows = store.db
			.select()
			.from(replayMetrics)
			.where(eq(replayMetrics.replayId, replayId))
			.all();
		expect(rows.length).toBe(2);
		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.analysisStep).toBe("metrics");
		expect(runner.enqueued).toEqual([{ name: "evaluate-replay", payload: { replayId } }]);
		store.close();
	});

	it("stamps failed + failure_reason='metrics_failed' on internal error", async () => {
		const { store, replayId } = await setupReplay();
		store.db
			.insert(replayTurns)
			.values({
				replayId,
				idx: 0,
				role: "user",
				turnStartMs: 0,
				turnEndMs: 1,
				voiceStartMs: 0,
				voiceEndMs: 1,
			})
			.run();
		// A throwing enqueue is the cheapest in-stage failure that reaches the
		// processor's catch — the pure compute path has no injectable fault.
		const runner = makeFakeJobRunner();
		const throwingRunner = {
			...runner,
			async enqueue() {
				throw new Error("runner is down");
			},
		};
		const processor = makeCalculateMetricsProcessor(store, makeReplayEvents(), throwingRunner);
		await expect(processor({ replayId })).rejects.toThrow(/metrics stage failed/);
		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.lifecycleState).toBe("failed");
		expect(after?.failureReason).toBe("metrics_failed");
		store.close();
	});

	it("throws when the replay row doesn't exist", async () => {
		const store = makeTempStore();
		const runner = makeFakeJobRunner();
		const processor = makeCalculateMetricsProcessor(store, makeReplayEvents(), runner);
		await expect(processor({ replayId: "00000000-0000-0000-0000-000000000099" })).rejects.toThrow(
			/replay row not found/,
		);
		store.close();
	});

	it("live: finalizes to completed + emits evaluation_complete, skips evaluate-replay", async () => {
		const { store, replayId } = await setupReplay({ live: true });
		store.db
			.insert(replayTurns)
			.values([
				{
					replayId,
					idx: 0,
					role: "user",
					turnStartMs: 0,
					turnEndMs: 1000,
					voiceStartMs: 0,
					voiceEndMs: 1000,
				},
				{
					replayId,
					idx: 1,
					role: "agent",
					turnStartMs: 1000,
					turnEndMs: 2500,
					voiceStartMs: 1300,
					voiceEndMs: 2500,
				},
			])
			.run();

		const events = makeReplayEvents();
		const seen: Array<{ type: string }> = [];
		events.subscribe(replayId, (e) => seen.push(e));
		const runner = makeFakeJobRunner();
		const processor = makeCalculateMetricsProcessor(store, events, runner);
		const result = await processor({ replayId });

		expect(result.ok).toBe(true);
		// Metrics still written (latency etc. are useful for a live session).
		const metricRows = store.db
			.select()
			.from(replayMetrics)
			.where(eq(replayMetrics.replayId, replayId))
			.all();
		expect(metricRows.length).toBe(2);

		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.lifecycleState).toBe("completed");
		expect(after?.analysisStep).toBeNull();
		expect(after?.finishedAt).not.toBeNull();

		const evalRow = store.db
			.select()
			.from(replayEvaluations)
			.where(eq(replayEvaluations.replayId, replayId))
			.get();
		expect(evalRow?.passed).toBe(true);
		expect(evalRow?.assertionsTotal).toBe(0);
		expect(evalRow?.judgesTotal).toBe(0);

		// The live branch must NOT chain to evaluate-replay.
		expect(runner.enqueued).toEqual([]);

		const complete = seen.find((e) => e.type === "evaluation_complete");
		expect(complete).toBeDefined();
		store.close();
	});
});
