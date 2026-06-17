import { and, asc, eq } from "drizzle-orm";
import { match, P } from "ts-pattern";

import { SpecVadMismatchError } from "@/server/assertions/assertions.errors.ts";
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
} from "@/server/replays/replays.types.ts";
import type { TurnWindow } from "@/server/replays/timeline.ts";
import { audioOffsetMs, clampedTurnWindows, rowsInTurnWindow } from "@/server/replays/timeline.ts";
import { projectTurnMetrics } from "@/server/replays/turn-metrics.ts";
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
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

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
			// Advance the analysis step to `evaluate` so the inspector's progress
			// bar lights its final node while assertions + judges run (judges can
			// be slow LLM calls). Guarded on the `analyzing` claim — a concurrent
			// failure/PATCH that already moved the row off `analyzing` must not be
			// dragged back to `evaluate`.
			const claimedEvaluate = store.db
				.update(replays)
				.set({ analysisStep: "evaluate" })
				.where(and(eq(replays.id, replayId), eq(replays.lifecycleState, "analyzing")))
				.returning({ id: replays.id })
				.all();
			if (claimedEvaluate.length > 0) {
				events.emit(replayId, {
					type: "state",
					lifecycle_state: "analyzing",
					analysis_step: "evaluate",
				});
			}

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

			// Tiling attribution windows for every VAD turn, in idx order, built
			// from each turn's voiceEndMs — the voice-active boundary the spec
			// attributes against (0001 §3.4), not turnEndMs (equal today, but
			// stored separately for future overlap handling). Built once (the
			// cursor accumulates across all turns, including extra VAD turns the
			// spec doesn't assert) and looked up per matched turn.
			const windows = clampedTurnWindows(turnRows.map((t) => t.voiceEndMs));
			const windowByIdx = new Map<number, TurnWindow>();
			for (let t = 0; t < turnRows.length; t++) {
				const row = turnRows[t];
				const window = windows[t];
				if (row !== undefined && window !== undefined) windowByIdx.set(row.idx, window);
			}

			const evaluatedAt = new Date().toISOString();
			const assertionRows: AssertionResultInsert[] = [];
			const assertionOutcomes: AssertionOutcomeResponse[] = [];

			// Align spec turns to VAD-derived turns by role-order walk. The
			// spec declares the conversation the dev wrote; VAD reports what
			// actually happened on the wire. We pair them by walking both in
			// order and advancing the VAD cursor to the next role-matching
			// row. Extra VAD turns (background noise, agent self-correction,
			// stutter that produced a phantom turn split) are tolerated —
			// they're persisted + transcribed + OTel-attributed by the prior
			// stages; they just don't drive an assertion. The walk fails
			// when the cursor exhausts `turnRows` before every spec turn has
			// been matched — that's the recording materially diverged from
			// the script, and the dev needs to see it loudly.
			let vadCursor = 0;
			for (let i = 0; i < spec.turns.length; i++) {
				const turn = spec.turns[i];
				if (turn === undefined) continue;
				let matchIdx = vadCursor;
				while (matchIdx < turnRows.length && turnRows[matchIdx]?.role !== turn.role) {
					matchIdx++;
				}
				const matched = turnRows[matchIdx];
				if (matched === undefined) {
					throw new SpecVadMismatchError(i, turn.role, spec.turns.length, turnRows.length);
				}
				vadCursor = matchIdx + 1;

				const assertions = turn.assertions ?? [];
				if (assertions.length === 0) continue;
				const ctx = buildAssertionContext(
					matched,
					windowByIdx.get(matched.idx),
					transcripts,
					metricRows,
					toolRows,
					usageRows,
					replay.recordingStartedAt,
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
				// Idempotency guard — if the row is no longer in `analyzing`
				// (operator PATCH, prior failed-stamp, completed by a
				// concurrent worker) we must NOT overwrite the existing
				// assertion / judge / evaluation rows. Read state first; bail
				// out of the write phase before any DELETE runs.
				const current = tx.select().from(replays).where(eq(replays.id, replayId)).get();
				if (current?.lifecycleState !== "analyzing") return false;

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
					.where(eq(replays.id, replayId))
					.run();
				return true;
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
				metrics: { turns: projectTurnMetrics(turnRows, metricRows) },
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
			// Map typed evaluator errors to specific failure_reasons so the
			// operator sees the right next step in `replays.failure_reason`.
			// Default is `evaluation_failed` for the unclassified evaluator
			// crash.
			const reason = match(cause)
				.with(P.instanceOf(SpecVadMismatchError), () => "spec_vad_mismatch" as const)
				.with(P.instanceOf(MissingProviderCredentialError), () => "missing_credential" as const)
				.otherwise(() => "evaluation_failed" as const);
			markReplayFailed(store, events, replayId, reason);
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new JobProcessingError(replayId, `evaluation stage failed: ${detail}`, { cause });
		}
	};
}

/**
 * Build the per-assertion context against a specific VAD-derived turn.
 *
 * `transcripts` + `metrics` are keyed on the VAD row's `idx`. `tool_calls` /
 * `model_usage` carry no stored turn idx — membership is the tiling attribution
 * `window` (`clampedTurnWindows`, see `src/server/replays/timeline.ts`) applied
 * to each row's wall-clock `started_at` against the replay's
 * `recording_started_at`. A row whose call fired before the user stopped
 * (speculative) or after the agent finished lands in a neighbouring turn's tile
 * and is excluded — `tool_called` then flags the mistiming.
 *
 * `ttftMs` is the earliest in-window model call's `model_usage.ttft_ms` — a
 * span-level, same-clock delta, not a per-turn aggregate.
 *
 * When `recordingStartedAt` is null (or no window exists for this turn) the rows
 * can't be placed on the timeline; `hasRecordingAnchor` is false and the
 * evaluator maps tool/ttft assertions to `errored` rather than a misleading
 * pass/fail.
 */
function buildAssertionContext(
	matched: ReplayTurnRow,
	window: TurnWindow | undefined,
	transcripts: readonly TurnTranscriptRow[],
	metrics: readonly ReplayMetricRow[],
	toolRows: readonly ToolCallRow[],
	usageRows: readonly ModelUsageRow[],
	recordingStartedAt: string | null,
): AssertionContext {
	const vadIdx = matched.idx;
	const transcript = transcripts.find((t) => t.turnIdx === vadIdx)?.text ?? null;
	const metric = metrics.find((m) => m.turnIdx === vadIdx);
	const usageInWindow =
		window === undefined ? [] : rowsInTurnWindow(usageRows, window, recordingStartedAt);
	return {
		turnIdx: vadIdx,
		turnRole: matched.role,
		transcript,
		hasRecordingAnchor: recordingStartedAt !== null && window !== undefined,
		toolCalls: window === undefined ? [] : rowsInTurnWindow(toolRows, window, recordingStartedAt),
		modelUsage: usageInWindow,
		metrics: {
			agentResponseMs: metric?.agentResponseMs ?? null,
			ttftMs: earliestTtftMs(usageInWindow, recordingStartedAt),
		},
	};
}

/**
 * TTFT of the earliest (by audio offset) in-window model call that actually
 * carries one, or null when none does. We pick the earliest call's measurement
 * (spec §3.4: "the first LLM call's perceived first-chunk latency"), but skip
 * rows whose `ttftMs` is null — a leading call that didn't emit
 * `gen_ai.response.time_to_first_chunk` (e.g. a Langfuse-vocabulary span, which
 * never carries it) must not mask a later call that did, which would make
 * `max_ttft_ms` falsely report "no call carried TTFT".
 */
function earliestTtftMs(
	usageInWindow: readonly ModelUsageRow[],
	recordingStartedAt: string | null,
): number | null {
	let earliestTtft: number | null = null;
	let earliestOffset = Number.POSITIVE_INFINITY;
	for (const row of usageInWindow) {
		if (row.ttftMs === null) continue;
		const offset = audioOffsetMs(row.startedAt, recordingStartedAt);
		if (offset === null) continue;
		if (offset < earliestOffset) {
			earliestOffset = offset;
			earliestTtft = row.ttftMs;
		}
	}
	return earliestTtft;
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
		// `MissingProviderCredentialError` is not a transient per-judge failure
		// — the entire stage can't run without the key. Re-throw it so the
		// outer catch in the processor maps it to
		// `failure_reason='missing_credential'`, which prompts the operator
		// to set the configured provider's API key rather than retry the run.
		if (cause instanceof MissingProviderCredentialError) {
			throw cause;
		}
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
