import { and, asc, eq } from "drizzle-orm";
import { match } from "ts-pattern";

import { evaluateAssertion } from "@/server/assertions/assertions.evaluator.ts";
import type { AssertionContext } from "@/server/assertions/assertions.types.ts";
import { getConversationSpec } from "@/server/conversations/conversations.service.ts";
import { JudgeError } from "@/server/judges/judges.errors.ts";
import type { JudgeTranscriptTurn } from "@/server/judges/judges.text-match.ts";
import { runTextMatchJudge } from "@/server/judges/judges.text-match.ts";
import type { Judge, JudgeOutcome, JudgeProvider } from "@/server/judges/judges.types.ts";
import type { ReplayEvents } from "@/server/replays/replays.events.ts";
import { findReplay, markReplayFailed } from "@/server/replays/replays.service.ts";
import type {
	AssertionOutcomeResponse,
	JudgeOutcomeResponse,
	ReplayResult,
	TurnMetricsResponse,
} from "@/server/replays/replays.types.ts";
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
import type { Store } from "@/server/store/store.ts";
import type {
	ModelUsageRow,
	ReplayMetricRow,
	ReplayTurnRow,
	ToolCallRow,
	TurnTranscriptRow,
} from "@/server/store/types.ts";

import { JobProcessingError } from "../jobs.errors.ts";
import type { JobPayload } from "../jobs.types.ts";

export interface EvaluateReplayResult {
	readonly ok: true;
	readonly passed: boolean;
	readonly assertionsTotal: number;
	readonly assertionsPassed?: number;
	readonly judgesTotal?: number;
	readonly judgesPassed?: number;
}

export type EvaluateReplayProcessor = (payload: JobPayload) => Promise<EvaluateReplayResult>;

type AssertionResultInsert = typeof assertionResults.$inferInsert;
type JudgeResultInsert = typeof judgeResults.$inferInsert;

/**
 * Stage 3 (final) of the analyze chain. Runs every declared assertion +
 * judge against the rows produced by stages 1+2. Writes the per-row
 * outcomes, the aggregate `replay_evaluations` row, flips the replay to
 * `completed`, then emits the `evaluation_complete` SSE — the SDK reads
 * it and returns `ReplayResult`.
 *
 * Pass/fail aggregation: `passed = all assertions "passed" && all judges
 * "passed"`. `errored` counts as not-passed — a missing transcript or a
 * crashing judge is a failure of the test as a unit, not a separate
 * "errored" replay state.
 */
export function makeEvaluateReplayProcessor(
	store: Store,
	events: ReplayEvents,
	judgeProvider: JudgeProvider,
): EvaluateReplayProcessor {
	return async ({ replayId }) => {
		const replay = findReplay(store, replayId);
		if (replay === undefined) {
			throw new JobProcessingError(replayId, "replay row not found");
		}

		try {
			const spec = getConversationSpec(store, replay.conversationHash);
			if (spec === undefined) {
				throw new JobProcessingError(replayId, `conversation ${replay.conversationHash} not found`);
			}

			const turnRows = store.db
				.select()
				.from(replayTurns)
				.where(eq(replayTurns.replayId, replayId))
				.orderBy(asc(replayTurns.idx))
				.all();
			const transcripts = store.db
				.select()
				.from(turnTranscripts)
				.where(eq(turnTranscripts.replayId, replayId))
				.all();
			const metricRows = store.db
				.select()
				.from(replayMetrics)
				.where(eq(replayMetrics.replayId, replayId))
				.all();
			const toolRows = store.db
				.select()
				.from(toolCalls)
				.where(eq(toolCalls.replayId, replayId))
				.all();
			const usageRows = store.db
				.select()
				.from(modelUsage)
				.where(eq(modelUsage.replayId, replayId))
				.all();

			const evaluatedAt = new Date().toISOString();
			const assertionRows: AssertionResultInsert[] = [];
			const assertionOutcomes: AssertionOutcomeResponse[] = [];

			for (let i = 0; i < spec.turns.length; i++) {
				const turn = spec.turns[i];
				if (turn === undefined) continue;
				const assertions = turn.assertions ?? [];
				if (assertions.length === 0) continue;
				const ctx = buildAssertionContext(
					i,
					turnRows,
					transcripts,
					metricRows,
					toolRows,
					usageRows,
				);
				for (let j = 0; j < assertions.length; j++) {
					const assertion = assertions[j];
					if (assertion === undefined) continue;
					const outcome = evaluateAssertion(assertion, ctx);
					assertionRows.push({
						replayId,
						turnIdx: i,
						assertionIdx: j,
						kind: assertion.kind,
						paramsJson: JSON.stringify(assertion),
						status: outcome.status,
						message: outcome.message,
						evaluatedAt,
					});
					assertionOutcomes.push({
						turn_idx: i,
						assertion_idx: j,
						kind: assertion.kind,
						status: outcome.status,
						message: outcome.message,
					});
				}
			}

			const judgeRows: JudgeResultInsert[] = [];
			const judgeOutcomes: JudgeOutcomeResponse[] = [];
			const judgeTurns = buildJudgeTurns(turnRows, transcripts);
			for (let k = 0; k < spec.judges.length; k++) {
				const judge = spec.judges[k];
				if (judge === undefined) continue;
				const outcome = await runOneJudge(judge, judgeTurns, judgeProvider);
				judgeRows.push({
					replayId,
					judgeIdx: k,
					kind: judge.kind,
					paramsJson: JSON.stringify(judge),
					status: outcome.status,
					score: outcome.score,
					reason: outcome.reason,
					provider: outcome.provider,
					model: outcome.model,
					evaluatedAt,
				});
				judgeOutcomes.push({
					judge_idx: k,
					kind: judge.kind,
					status: outcome.status,
					score: outcome.score,
					reason: outcome.reason,
				});
			}

			const assertionsPassed = assertionOutcomes.filter((a) => a.status === "passed").length;
			const judgesPassed = judgeOutcomes.filter((j) => j.status === "passed").length;
			const passed =
				assertionsPassed === assertionOutcomes.length && judgesPassed === judgeOutcomes.length;

			const advanced = store.db.transaction((tx) => {
				tx.delete(assertionResults).where(eq(assertionResults.replayId, replayId)).run();
				if (assertionRows.length > 0) tx.insert(assertionResults).values(assertionRows).run();
				tx.delete(judgeResults).where(eq(judgeResults.replayId, replayId)).run();
				if (judgeRows.length > 0) tx.insert(judgeResults).values(judgeRows).run();
				tx.delete(replayEvaluations).where(eq(replayEvaluations.replayId, replayId)).run();
				tx.insert(replayEvaluations)
					.values({
						replayId,
						passed,
						assertionsTotal: assertionOutcomes.length,
						assertionsPassed,
						judgesTotal: judgeOutcomes.length,
						judgesPassed,
						evaluatedAt,
					})
					.run();
				tx.update(replays)
					.set({
						lifecycleState: "completed",
						analysisStep: null,
						finishedAt: evaluatedAt,
					})
					.where(and(eq(replays.id, replayId), eq(replays.lifecycleState, "analyzing")))
					.run();
				const after = tx.select().from(replays).where(eq(replays.id, replayId)).get();
				return after?.lifecycleState === "completed";
			});

			if (!advanced) {
				console.warn(
					`evaluate-replay worker for ${replayId} found the row no longer in 'analyzing' — skipping completed emit`,
				);
				return { ok: true, passed: false, assertionsTotal: assertionOutcomes.length };
			}

			const result: ReplayResult = {
				replay_id: replayId,
				conversation_hash: replay.conversationHash,
				passed,
				assertions: assertionOutcomes,
				judges: judgeOutcomes,
				metrics: { turns: buildTurnMetricsResponse(turnRows, metricRows) },
			};

			events.emit(replayId, {
				type: "state",
				lifecycle_state: "completed",
				analysis_step: null,
			});
			events.emit(replayId, { type: "evaluation_complete", result });

			return {
				ok: true,
				passed,
				assertionsTotal: assertionOutcomes.length,
				assertionsPassed,
				judgesTotal: judgeOutcomes.length,
				judgesPassed,
			};
		} catch (cause) {
			markReplayFailed(store, events, replayId, "evaluation_failed");
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new JobProcessingError(replayId, `evaluation stage failed: ${detail}`, { cause });
		}
	};
}

function buildAssertionContext(
	turnIdx: number,
	turnRows: readonly ReplayTurnRow[],
	transcripts: readonly TurnTranscriptRow[],
	metrics: readonly ReplayMetricRow[],
	toolRows: readonly ToolCallRow[],
	usageRows: readonly ModelUsageRow[],
): AssertionContext {
	const turn = turnRows.find((t) => t.idx === turnIdx);
	const transcript = transcripts.find((t) => t.turnIdx === turnIdx)?.text ?? null;
	const metric = metrics.find((m) => m.turnIdx === turnIdx);
	return {
		turnIdx,
		turnRole: turn?.role ?? "agent",
		transcript,
		toolCalls: toolRows.filter((tc) => tc.turnIdx === turnIdx),
		modelUsage: usageRows.filter((mu) => mu.turnIdx === turnIdx),
		metrics: {
			agentResponseMs: metric?.agentResponseMs ?? null,
			ttftMs: metric?.ttftMs ?? null,
		},
	};
}

function buildJudgeTurns(
	turnRows: readonly ReplayTurnRow[],
	transcripts: readonly TurnTranscriptRow[],
): JudgeTranscriptTurn[] {
	const roleByTurnIdx = new Map(turnRows.map((r) => [r.idx, r.role]));
	const out: JudgeTranscriptTurn[] = [];
	for (const t of transcripts) {
		const role = roleByTurnIdx.get(t.turnIdx);
		if (role === undefined) continue;
		out.push({ turnIdx: t.turnIdx, role, text: t.text });
	}
	return out;
}

function buildTurnMetricsResponse(
	turnRows: readonly ReplayTurnRow[],
	metricRows: readonly ReplayMetricRow[],
): TurnMetricsResponse[] {
	const metricByTurnIdx = new Map(metricRows.map((m) => [m.turnIdx, m]));
	return turnRows.map((turn) => {
		const metric = metricByTurnIdx.get(turn.idx);
		return {
			turn_idx: turn.idx,
			role: turn.role,
			agent_response_ms: metric?.agentResponseMs ?? null,
			ttft_ms: metric?.ttftMs ?? null,
			interrupted: metric?.interrupted ?? false,
		};
	});
}

async function runOneJudge(
	judge: Judge,
	transcripts: readonly JudgeTranscriptTurn[],
	provider: JudgeProvider,
): Promise<JudgeOutcome> {
	try {
		return await match(judge)
			.with({ kind: "text_match" }, (j) =>
				runTextMatchJudge(
					{ reference: j.reference, rubric: j.rubric ?? null, passScore: j.pass_score },
					transcripts,
					provider,
				),
			)
			.exhaustive();
	} catch (cause) {
		// Per-judge failures map to "errored" outcomes — they don't fail the
		// whole stage. The processor's outer catch only fires for evaluator
		// internals (e.g. malformed conversation spec).
		if (cause instanceof JudgeError) {
			return {
				status: "errored",
				score: null,
				reason: cause.message,
				provider: provider.name,
				model: provider.model,
			};
		}
		throw cause;
	}
}
