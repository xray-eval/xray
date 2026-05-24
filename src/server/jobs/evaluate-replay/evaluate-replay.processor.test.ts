import { eq } from "drizzle-orm";

import type { Assertion } from "@/server/assertions/assertions.types.ts";
import { seedConversation } from "@/server/conversations/conversations.test-utils.ts";
import type { ConversationTurn } from "@/server/conversations/conversations.types.ts";
import type { Judge } from "@/server/judges/judges.types.ts";
import type {
	ReplayEvaluationCompleteEvent,
	ReplayEvent,
} from "@/server/replays/replays.events.ts";
import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import {
	assertionResults,
	judgeResults,
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	turnTranscripts,
} from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { makeEvaluateReplayProcessor } from "./evaluate-replay.processor.ts";
import { describe, expect, it } from "bun:test";

function fakeJudge(score = 95, reason = "matches") {
	return {
		name: "fake",
		model: "fake-1",
		judge: async () => ({ score, reason }),
	};
}

async function setupReplay(opts: {
	turns?: Array<{ role: "user" | "agent"; assertions?: Assertion[] }>;
	judges?: Judge[];
}) {
	const store = makeTempStore();
	const turns: ConversationTurn[] = opts.turns?.map((t, i) =>
		t.role === "user"
			? { role: "user", text: `user-${i}`, key: `k${i}`, assertions: t.assertions ?? [] }
			: { role: "agent", key: `k${i}`, assertions: t.assertions ?? [] },
	) ?? [
		{ role: "user", text: "hi", key: "u0", assertions: [] },
		{ role: "agent", key: "a0", assertions: [] },
	];
	const { hash } = await seedConversation(store, {
		turns,
		judges: opts.judges ?? [],
	});
	const detail = createReplay(store, { conversation_hash: hash });

	// Set up the replay in `analyzing` so the processor's WHERE guard hits.
	store.db
		.update(replays)
		.set({ lifecycleState: "analyzing", analysisStep: "metrics" })
		.where(eq(replays.id, detail.id))
		.run();

	// Seed two turn rows (user idx 0, agent idx 1) — enough for the
	// assertion contexts the test cares about.
	store.db
		.insert(replayTurns)
		.values([
			{
				replayId: detail.id,
				idx: 0,
				role: "user",
				turnStartMs: 0,
				turnEndMs: 1000,
				voiceStartMs: 0,
				voiceEndMs: 1000,
			},
			{
				replayId: detail.id,
				idx: 1,
				role: "agent",
				turnStartMs: 1000,
				turnEndMs: 2500,
				voiceStartMs: 1300,
				voiceEndMs: 2500,
			},
		])
		.run();
	store.db
		.insert(turnTranscripts)
		.values([
			{
				replayId: detail.id,
				turnIdx: 0,
				text: "book a table",
				language: "en",
				wordsJson: null,
				durationMs: 1000,
				provider: "fake",
				model: "fake-1",
			},
			{
				replayId: detail.id,
				turnIdx: 1,
				text: "confirmed for two",
				language: "en",
				wordsJson: null,
				durationMs: 1200,
				provider: "fake",
				model: "fake-1",
			},
		])
		.run();
	store.db
		.insert(replayMetrics)
		.values([
			{
				replayId: detail.id,
				turnIdx: 0,
				agentResponseMs: null,
				ttftMs: null,
				interrupted: false,
				interruptionStartMs: null,
			},
			{
				replayId: detail.id,
				turnIdx: 1,
				agentResponseMs: 300,
				ttftMs: 100,
				interrupted: false,
				interruptionStartMs: null,
			},
		])
		.run();

	return { store, replayId: detail.id, conversationHash: hash };
}

describe("evaluate-replay processor", () => {
	it("writes assertion_results, judge_results, replay_evaluations and flips lifecycle to completed", async () => {
		const { store, replayId } = await setupReplay({
			turns: [
				{ role: "user", assertions: [] },
				{
					role: "agent",
					assertions: [
						{ kind: "contains", text: "confirmed", case_insensitive: true },
						{ kind: "max_latency_ms", max_ms: 500 },
					],
				},
			],
			judges: [{ kind: "text_match", reference: "agent confirms booking", pass_score: 70 }],
		});

		const events = makeReplayEvents();
		const seen: ReplayEvent[] = [];
		events.subscribe(replayId, (e) => seen.push(e));

		const processor = makeEvaluateReplayProcessor(store, events, fakeJudge(95));
		const result = await processor({ replayId });

		expect(result.ok).toBe(true);
		expect(result.passed).toBe(true);

		const ars = store.db
			.select()
			.from(assertionResults)
			.where(eq(assertionResults.replayId, replayId))
			.all();
		expect(ars.length).toBe(2);
		expect(ars.every((r) => r.status === "passed")).toBe(true);

		const jrs = store.db
			.select()
			.from(judgeResults)
			.where(eq(judgeResults.replayId, replayId))
			.all();
		expect(jrs.length).toBe(1);
		expect(jrs[0]?.status).toBe("passed");
		expect(jrs[0]?.score).toBe(95);

		const evalRow = store.db
			.select()
			.from(replayEvaluations)
			.where(eq(replayEvaluations.replayId, replayId))
			.get();
		expect(evalRow?.passed).toBe(true);

		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.lifecycleState).toBe("completed");

		const completeEvents = seen.filter(
			(e): e is ReplayEvaluationCompleteEvent => e.type === "evaluation_complete",
		);
		expect(completeEvents.length).toBe(1);
		expect(completeEvents[0]?.result.passed).toBe(true);
		expect(completeEvents[0]?.result.assertions.length).toBe(2);
		expect(completeEvents[0]?.result.judges.length).toBe(1);
	});

	it("aggregates passed=false when any assertion fails", async () => {
		const { store, replayId } = await setupReplay({
			turns: [
				{ role: "user", assertions: [] },
				{
					role: "agent",
					assertions: [{ kind: "contains", text: "nothing matches", case_insensitive: true }],
				},
			],
			judges: [],
		});
		const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge());
		const result = await processor({ replayId });
		expect(result.passed).toBe(false);
		const evalRow = store.db
			.select()
			.from(replayEvaluations)
			.where(eq(replayEvaluations.replayId, replayId))
			.get();
		expect(evalRow?.passed).toBe(false);
		expect(evalRow?.assertionsTotal).toBe(1);
		expect(evalRow?.assertionsPassed).toBe(0);
	});

	it("aggregates passed=false when a judge falls below pass_score", async () => {
		const { store, replayId } = await setupReplay({
			turns: [
				{ role: "user", assertions: [] },
				{ role: "agent", assertions: [] },
			],
			judges: [{ kind: "text_match", reference: "x", pass_score: 70 }],
		});
		const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge(40));
		const result = await processor({ replayId });
		expect(result.passed).toBe(false);
	});

	it("maps a judge provider error to status=errored without aborting the stage", async () => {
		const { store, replayId } = await setupReplay({
			turns: [
				{ role: "user", assertions: [] },
				{ role: "agent", assertions: [] },
			],
			judges: [{ kind: "text_match", reference: "x", pass_score: 70 }],
		});
		const events = makeReplayEvents();
		const { JudgeProviderError } = await import("@/server/judges/judges.errors.ts");
		const erroringProvider = {
			name: "fake",
			model: "fake-1",
			judge: async () => {
				throw new JudgeProviderError("fake", "unreachable");
			},
		};
		const processor = makeEvaluateReplayProcessor(store, events, erroringProvider);
		const result = await processor({ replayId });
		expect(result.ok).toBe(true);
		expect(result.passed).toBe(false);
		const jrs = store.db
			.select()
			.from(judgeResults)
			.where(eq(judgeResults.replayId, replayId))
			.all();
		expect(jrs[0]?.status).toBe("errored");
		expect(jrs[0]?.score).toBeNull();
		expect(jrs[0]?.reason).toContain("fake");
	});

	it("stamps failed + failure_reason='evaluation_failed' when the judge provider crashes with a non-JudgeError", async () => {
		const { store, replayId } = await setupReplay({
			turns: [
				{ role: "user", assertions: [] },
				{ role: "agent", assertions: [] },
			],
			judges: [{ kind: "text_match", reference: "x", pass_score: 70 }],
		});
		// Non-JudgeError → runOneJudge re-throws → outer catch stamps
		// failure_reason='evaluation_failed'. JudgeError subclasses map to
		// per-judge `errored` status (covered by the test above).
		const crashingProvider = {
			name: "fake",
			model: "fake-1",
			judge: async () => {
				throw new TypeError("unexpected provider crash");
			},
		};
		const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), crashingProvider);
		await expect(processor({ replayId })).rejects.toThrow(/evaluation stage failed/);
		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.lifecycleState).toBe("failed");
		expect(after?.failureReason).toBe("evaluation_failed");
		store.close();
	});
});
