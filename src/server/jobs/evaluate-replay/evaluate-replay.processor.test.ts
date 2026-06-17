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
	modelUsage,
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	toolCalls,
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

interface VadFixture {
	idx: number;
	role: "user" | "agent";
	transcript: string;
	turnStartMs?: number;
	turnEndMs?: number;
	voiceStartMs?: number;
	voiceEndMs?: number;
	agentResponseMs?: number | null;
}

async function setupReplay(opts: {
	turns?: Array<{ role: "user" | "agent"; assertions?: Assertion[] }>;
	judges?: Judge[];
	vadOverride?: VadFixture[];
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

	// Default VAD fixture: one user turn (idx 0) + one agent turn (idx 1)
	// with the agent transcript that the happy-path tests expect. Override
	// for divergence tests below.
	const vad: VadFixture[] = opts.vadOverride ?? [
		{
			idx: 0,
			role: "user",
			transcript: "book a table",
			turnStartMs: 0,
			turnEndMs: 1000,
			voiceStartMs: 0,
			voiceEndMs: 1000,
		},
		{
			idx: 1,
			role: "agent",
			transcript: "confirmed for two",
			turnStartMs: 1000,
			turnEndMs: 2500,
			voiceStartMs: 1300,
			voiceEndMs: 2500,
			agentResponseMs: 300,
		},
	];

	store.db
		.insert(replayTurns)
		.values(
			vad.map((t) => ({
				replayId: detail.id,
				idx: t.idx,
				role: t.role,
				turnStartMs: t.turnStartMs ?? 0,
				turnEndMs: t.turnEndMs ?? 1000,
				voiceStartMs: t.voiceStartMs ?? 0,
				voiceEndMs: t.voiceEndMs ?? 1000,
			})),
		)
		.run();
	store.db
		.insert(turnTranscripts)
		.values(
			vad.map((t) => ({
				replayId: detail.id,
				turnIdx: t.idx,
				text: t.transcript,
				language: "en",
				wordsJson: null,
				durationMs: 1000,
				provider: "fake",
				model: "fake-1",
			})),
		)
		.run();
	store.db
		.insert(replayMetrics)
		.values(
			vad.map((t) => ({
				replayId: detail.id,
				turnIdx: t.idx,
				agentResponseMs: t.role === "agent" ? (t.agentResponseMs ?? 300) : null,
				interrupted: false,
				interruptionStartMs: null,
			})),
		)
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

		// The processor stamps + broadcasts the `evaluate` analysis step on entry
		// so the inspector's progress bar can light its final node while the
		// assertions/judges run.
		const evaluateState = seen.find((e) => e.type === "state" && e.analysis_step === "evaluate");
		expect(evaluateState).toBeDefined();
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

	describe("idempotency under retry against terminal row", () => {
		it("does NOT trash existing assertion_results / judge_results / replay_evaluations when re-run against a `failed` row", async () => {
			// Seed an existing failed-state replay with pre-existing assertion
			// + judge + evaluation rows from a prior run. The processor MUST
			// detect the non-analyzing lifecycle and bail out before any
			// DELETE.
			const { store, replayId } = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{
						role: "agent",
						assertions: [{ kind: "contains", text: "confirmed", case_insensitive: true }],
					},
				],
				judges: [],
			});
			// Pre-seed an evaluation row + flip lifecycle to `failed`.
			store.db
				.insert(replayEvaluations)
				.values({
					replayId,
					passed: false,
					assertionsTotal: 1,
					assertionsPassed: 0,
					judgesTotal: 0,
					judgesPassed: 0,
					evaluatedAt: new Date(0).toISOString(),
				})
				.run();
			store.db
				.update(replays)
				.set({ lifecycleState: "failed", failureReason: "transcription_failed" })
				.where(eq(replays.id, replayId))
				.run();

			const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge());
			const result = await processor({ replayId });
			expect(result.ok).toBe(true);

			const evalRow = store.db
				.select()
				.from(replayEvaluations)
				.where(eq(replayEvaluations.replayId, replayId))
				.get();
			// Pre-seeded row preserved — its evaluatedAt is epoch.
			expect(evalRow?.evaluatedAt).toBe(new Date(0).toISOString());
			const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
			expect(after?.lifecycleState).toBe("failed");
			expect(after?.failureReason).toBe("transcription_failed");
		});
	});

	describe("spec / VAD turn alignment", () => {
		it("tolerates extra VAD turns when spec turns still align by role-order", async () => {
			// Spec: [user, agent]. VAD: [user, user-noise, agent]. The walk
			// finds user at idx 0, then advances past the noise to agent at
			// idx 2. Assertion runs against the agent VAD row's transcript.
			const { store, replayId } = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{
						role: "agent",
						assertions: [{ kind: "contains", text: "confirmed", case_insensitive: true }],
					},
				],
				judges: [],
				vadOverride: [
					{ idx: 0, role: "user", transcript: "book a table" },
					{ idx: 1, role: "user", transcript: "uhh" },
					{ idx: 2, role: "agent", transcript: "confirmed for two" },
				],
			});
			const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge());
			const result = await processor({ replayId });
			expect(result.passed).toBe(true);
			const ars = store.db
				.select()
				.from(assertionResults)
				.where(eq(assertionResults.replayId, replayId))
				.all();
			expect(ars.length).toBe(1);
			expect(ars[0]?.status).toBe("passed");
		});

		it("stamps failed + spec_vad_mismatch when VAD has fewer matching role turns than spec", async () => {
			// Spec: [user, agent, user, agent]. VAD: [user, agent]. The walk
			// matches spec[0] → vad[0], spec[1] → vad[1], then spec[2]=user
			// finds no remaining VAD turn → SpecVadMismatchError.
			const { store, replayId } = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{ role: "agent", assertions: [] },
					{ role: "user", assertions: [] },
					{ role: "agent", assertions: [] },
				],
				judges: [],
				vadOverride: [
					{ idx: 0, role: "user", transcript: "first" },
					{ idx: 1, role: "agent", transcript: "ok" },
				],
			});
			const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge());
			await expect(processor({ replayId })).rejects.toThrow(/evaluation stage failed/);
			const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
			expect(after?.lifecycleState).toBe("failed");
			expect(after?.failureReason).toBe("spec_vad_mismatch");
		});

		it("stamps failed + spec_vad_mismatch when role order diverges (vad starts with agent, spec with user)", async () => {
			const { store, replayId } = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{ role: "agent", assertions: [] },
				],
				judges: [],
				vadOverride: [
					{ idx: 0, role: "agent", transcript: "echo" },
					{ idx: 1, role: "agent", transcript: "echo again" },
				],
			});
			const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge());
			await expect(processor({ replayId })).rejects.toThrow(/evaluation stage failed/);
			const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
			expect(after?.lifecycleState).toBe("failed");
			expect(after?.failureReason).toBe("spec_vad_mismatch");
		});

		it("assertion context reads matched VAD-turn transcript even when VAD idx differs from spec idx", async () => {
			// Spec[1]=agent, VAD: [user idx 0, user idx 1 (noise), agent idx
			// 2]. Without the role-walk fix the assertion would look up
			// transcripts.find(turnIdx === 1) = the noise user-turn text,
			// fail the `contains` check, and report `passed=false`. With
			// role-walk it looks up VAD idx 2's transcript.
			const { store, replayId } = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{
						role: "agent",
						assertions: [{ kind: "contains", text: "agent text", case_insensitive: true }],
					},
				],
				judges: [],
				vadOverride: [
					{ idx: 0, role: "user", transcript: "hi" },
					{ idx: 1, role: "user", transcript: "noise" },
					{ idx: 2, role: "agent", transcript: "Agent Text — go" },
				],
			});
			const processor = makeEvaluateReplayProcessor(store, makeReplayEvents(), fakeJudge());
			const result = await processor({ replayId });
			expect(result.passed).toBe(true);
		});
	});

	describe("tool attribution by audio timeline", () => {
		// The agent turn's window is [turnStartMs=1000, turnEndMs=2500). A tool
		// call is attributed to it iff (started_at − recording_started_at) lands
		// in that window. recording_started_at is the SOLE origin — never
		// replays.started_at (row-creation time). See spec 0001.
		const RECORDING_T0 = "2026-05-26T14:31:31.023Z";
		const atOffset = (ms: number) => new Date(Date.parse(RECORDING_T0) + ms).toISOString();

		type ToolCtx = Awaited<ReturnType<typeof setupReplay>>;

		async function setupToolReplay(recordingStartedAt: string | null): Promise<ToolCtx> {
			const ctx = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{ role: "agent", assertions: [{ kind: "tool_called", name: "lookup" }] },
				],
				judges: [],
			});
			ctx.store.db
				.update(replays)
				.set({ recordingStartedAt })
				.where(eq(replays.id, ctx.replayId))
				.run();
			return ctx;
		}

		function insertTool(ctx: ToolCtx, startedAt: string): void {
			ctx.store.db
				.insert(toolCalls)
				.values({
					replayId: ctx.replayId,
					spanId: "s1",
					name: "lookup",
					argsJson: null,
					resultJson: null,
					startedAt,
					endedAt: startedAt,
					latencyMs: 0,
				})
				.run();
		}

		async function runAndGetToolStatus(ctx: ToolCtx): Promise<string | undefined> {
			await makeEvaluateReplayProcessor(
				ctx.store,
				makeReplayEvents(),
				fakeJudge(),
			)({
				replayId: ctx.replayId,
			});
			return ctx.store.db
				.select()
				.from(assertionResults)
				.where(eq(assertionResults.replayId, ctx.replayId))
				.all()
				.find((r) => r.kind === "tool_called")?.status;
		}

		it("passes tool_called when the call lands inside the agent turn window", async () => {
			const ctx = await setupToolReplay(RECORDING_T0);
			insertTool(ctx, atOffset(1500)); // offset 1500 ∈ [1000, 2500)
			expect(await runAndGetToolStatus(ctx)).toBe("passed");
		});

		it("flags a mistimed call: speculative-during-user-turn is NOT in the agent turn", async () => {
			const ctx = await setupToolReplay(RECORDING_T0);
			insertTool(ctx, atOffset(500)); // offset 500 ∈ user turn [0,1000), not agent's
			expect(await runAndGetToolStatus(ctx)).toBe("failed");
		});

		it("errors tool_called when the replay has no recording anchor", async () => {
			const ctx = await setupToolReplay(null);
			insertTool(ctx, atOffset(1500));
			expect(await runAndGetToolStatus(ctx)).toBe("errored");
		});
	});

	describe("ttft attribution by audio timeline", () => {
		// Same agent turn window [1000, 2500) as the tool block. max_ttft_ms
		// sources ttftMs from the earliest in-window model_usage row that
		// carries one. recording_started_at is the sole origin. See spec 0001.
		const RECORDING_T0 = "2026-05-26T14:31:31.023Z";
		const atOffset = (ms: number) => new Date(Date.parse(RECORDING_T0) + ms).toISOString();
		type Ctx = Awaited<ReturnType<typeof setupReplay>>;

		async function setupTtftReplay(): Promise<Ctx> {
			const ctx = await setupReplay({
				turns: [
					{ role: "user", assertions: [] },
					{ role: "agent", assertions: [{ kind: "max_ttft_ms", max_ms: 500 }] },
				],
				judges: [],
			});
			ctx.store.db
				.update(replays)
				.set({ recordingStartedAt: RECORDING_T0 })
				.where(eq(replays.id, ctx.replayId))
				.run();
			return ctx;
		}

		function insertUsage(ctx: Ctx, startedAt: string, ttftMs: number | null): void {
			ctx.store.db
				.insert(modelUsage)
				.values({
					replayId: ctx.replayId,
					spanId: `u-${startedAt}`,
					provider: "openai",
					model: "gpt-4o",
					inputTokens: null,
					outputTokens: null,
					totalTokens: null,
					ttftMs,
					startedAt,
					endedAt: startedAt,
					latencyMs: 0,
				})
				.run();
		}

		async function runAndGetTtft(
			ctx: Ctx,
		): Promise<{ status: string | undefined; message: string | null | undefined }> {
			await makeEvaluateReplayProcessor(
				ctx.store,
				makeReplayEvents(),
				fakeJudge(),
			)({
				replayId: ctx.replayId,
			});
			const row = ctx.store.db
				.select()
				.from(assertionResults)
				.where(eq(assertionResults.replayId, ctx.replayId))
				.all()
				.find((r) => r.kind === "max_ttft_ms");
			return { status: row?.status, message: row?.message };
		}

		it("passes when the earliest in-window model call's ttft is under the limit", async () => {
			const ctx = await setupTtftReplay();
			insertUsage(ctx, atOffset(1400), 300); // offset 1400 ∈ [1000, 2500)
			expect((await runAndGetTtft(ctx)).status).toBe("passed");
		});

		it("does NOT let a leading null-ttft call mask a later call that carries one", async () => {
			// Regression: a first in-window call without the TTFT attribute
			// (ttft=null) must not shadow a later call with a real measurement.
			const ctx = await setupTtftReplay();
			insertUsage(ctx, atOffset(1100), null); // earliest, no measurement
			insertUsage(ctx, atOffset(1400), 300); // later, carries TTFT under limit
			expect((await runAndGetTtft(ctx)).status).toBe("passed");
		});

		it("fails when the earliest measured ttft exceeds the limit", async () => {
			const ctx = await setupTtftReplay();
			insertUsage(ctx, atOffset(1200), 4000);
			const { status, message } = await runAndGetTtft(ctx);
			expect(status).toBe("failed");
			expect(message).toContain("4000ms");
		});

		it("errors with a 'no model call in window' message when no usage row lands in the turn", async () => {
			const ctx = await setupTtftReplay();
			insertUsage(ctx, atOffset(500), 300); // offset 500 ∈ user turn, not agent's
			const { status, message } = await runAndGetTtft(ctx);
			expect(status).toBe("errored");
			expect(message).toContain("no model call landed");
		});

		it("errors with an 'attribute missing' message when in-window calls carry no ttft", async () => {
			const ctx = await setupTtftReplay();
			insertUsage(ctx, atOffset(1400), null);
			const { status, message } = await runAndGetTtft(ctx);
			expect(status).toBe("errored");
			expect(message).toContain("time_to_first_chunk");
		});

		it("errors when the replay has no recording anchor", async () => {
			const ctx = await setupTtftReplay();
			ctx.store.db
				.update(replays)
				.set({ recordingStartedAt: null })
				.where(eq(replays.id, ctx.replayId))
				.run();
			insertUsage(ctx, atOffset(1400), 300);
			const { status, message } = await runAndGetTtft(ctx);
			expect(status).toBe("errored");
			expect(message).toContain("no recording anchor");
		});
	});
});
