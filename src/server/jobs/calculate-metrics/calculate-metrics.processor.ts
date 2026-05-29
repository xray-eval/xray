import { and, asc, eq } from "drizzle-orm";

import { getConversationSpec } from "@/server/conversations/conversations.service.ts";
import type { ReplayEvents } from "@/server/replays/replays.events.ts";
import { findReplay, markReplayFailed } from "@/server/replays/replays.service.ts";
import type { ReplayResult, TurnMetricsResponse } from "@/server/replays/replays.types.ts";
import {
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	spans,
	speechSegments,
} from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type { ReplayTurnRow, SpanRow, SpeechSegmentRow } from "@/server/store/types.ts";

import type { JobRunner } from "../jobs.bunqueue.ts";
import { JobProcessingError } from "../jobs.errors.ts";
import type { JobPayload } from "../jobs.types.ts";

export interface CalculateMetricsResult {
	readonly ok: true;
	readonly metricsWritten: number;
}

export type CalculateMetricsProcessor = (payload: JobPayload) => Promise<CalculateMetricsResult>;

/**
 * Stage 2 of the analyze chain. Reads the VAD-derived turns + speech
 * segments + raw spans, computes per-turn timing metrics, writes
 * `replay_metrics`. For a scripted replay it then bumps analysis_step to
 * `metrics` and enqueues `evaluate-replay`. For a live replay there's no
 * script to evaluate, so this stage is terminal: it finalizes in the same
 * transaction (writes an empty `replay_evaluations` row + flips lifecycle
 * to `completed`) and emits `evaluation_complete` directly.
 *
 * Metrics computed:
 * - `agentResponseMs` (agent turns only): gap from the prior user turn's
 *   `voice_end_ms` to this turn's `voice_start_ms`. Null for user turns
 *   and for the first agent turn when no prior user turn exists.
 * - `ttftMs` (agent turns only): offset from `voice_start_ms` back to the
 *   start of the FIRST gen_ai-vocabulary span attributed to this turn.
 *   Null when no span landed in the turn window — common for non-LLM
 *   agents.
 * - `interrupted`: true iff an opposite-channel speech segment started
 *   while this turn was still active.
 * - `interruptionStartMs`: the start of that overlap, when present.
 */
export function makeCalculateMetricsProcessor(
	store: Store,
	events: ReplayEvents,
	runner: JobRunner,
): CalculateMetricsProcessor {
	return async ({ replayId }) => {
		const replay = findReplay(store, replayId);
		if (replay === undefined) {
			throw new JobProcessingError(replayId, "replay row not found");
		}

		try {
			const turns = store.db
				.select()
				.from(replayTurns)
				.where(eq(replayTurns.replayId, replayId))
				.orderBy(asc(replayTurns.idx))
				.all();
			const segments = store.db
				.select()
				.from(speechSegments)
				.where(eq(speechSegments.replayId, replayId))
				.all();
			const ttftSpans = store.db
				.select()
				.from(spans)
				.where(and(eq(spans.replayId, replayId), eq(spans.vocabulary, "gen_ai")))
				.all();
			const replayStartMs = Date.parse(replay.startedAt);

			const rows = computeMetrics(replayId, turns, segments, ttftSpans, replayStartMs);

			// Decide live vs scripted BEFORE the transaction. The conversation
			// row is immutable post-creation (no live-flag flip), so reading it
			// outside the tx is safe.
			//
			// A missing conversation row reads as non-live so the chain still
			// routes to evaluate-replay, which surfaces the missing row as a
			// failure with full context.
			const spec = getConversationSpec(store, replay.conversationHash);
			const isLive = spec?.live ?? false;

			const advanced = store.db.transaction((tx) => {
				// Same idempotency rule as every chain stage: don't trash
				// existing rows if a concurrent path already flipped lifecycle
				// to `failed` or `completed`. Read the lifecycle first; abort
				// the write phase otherwise.
				const current = tx.select().from(replays).where(eq(replays.id, replayId)).get();
				if (current?.lifecycleState !== "analyzing") return false;

				tx.delete(replayMetrics).where(eq(replayMetrics.replayId, replayId)).run();
				if (rows.length > 0) tx.insert(replayMetrics).values(rows).run();

				if (isLive) {
					// Terminal step for a live replay: there's no script to
					// evaluate, so finalize in this SAME transaction. Splitting
					// metric-write + evaluation-write across two transactions
					// would leave a crash window where the replay sits forever
					// at `analyzing` (no chained evaluate-replay job to retry
					// it). Single tx eliminates that window entirely.
					// Captured inside the tx so the stored timestamp matches the
					// moment this row flips to `completed`, not a few ms earlier.
					const evaluatedAt = new Date().toISOString();
					tx.delete(replayEvaluations).where(eq(replayEvaluations.replayId, replayId)).run();
					tx.insert(replayEvaluations)
						.values({
							replayId,
							passed: true,
							assertionsTotal: 0,
							assertionsPassed: 0,
							judgesTotal: 0,
							judgesPassed: 0,
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
				} else {
					tx.update(replays).set({ analysisStep: "metrics" }).where(eq(replays.id, replayId)).run();
				}
				return true;
			});

			if (!advanced) {
				console.warn(
					`calculate-metrics worker for ${replayId} found the row no longer in 'analyzing' — skipping chain`,
				);
				return { ok: true, metricsWritten: rows.length };
			}

			if (isLive) {
				// Emit SSE events AFTER the commit so a subscriber can't see
				// `evaluation_complete` before the row reads as `completed`.
				const result: ReplayResult = {
					replay_id: replayId,
					conversation_hash: replay.conversationHash,
					passed: true,
					assertions: [],
					judges: [],
					metrics: { turns: buildLiveTurnMetrics(turns, rows) },
				};
				events.emit(replayId, {
					type: "state",
					lifecycle_state: "completed",
					analysis_step: null,
				});
				events.emit(replayId, { type: "evaluation_complete", result });
				return { ok: true, metricsWritten: rows.length };
			}

			events.emit(replayId, {
				type: "state",
				lifecycle_state: "analyzing",
				analysis_step: "metrics",
			});
			await runner.enqueue("evaluate-replay", { replayId });
			return { ok: true, metricsWritten: rows.length };
		} catch (cause) {
			markReplayFailed(store, events, replayId, "metrics_failed");
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new JobProcessingError(replayId, `metrics stage failed: ${detail}`, { cause });
		}
	};
}

type ComputedMetric = ReturnType<typeof computeMetrics>[number];

function buildLiveTurnMetrics(
	turns: readonly ReplayTurnRow[],
	metricRows: readonly ComputedMetric[],
): TurnMetricsResponse[] {
	const byIdx = new Map(metricRows.map((m) => [m.turnIdx, m]));
	return [...turns]
		.sort((a, b) => a.idx - b.idx)
		.map((turn) => {
			const metric = byIdx.get(turn.idx);
			return {
				turn_idx: turn.idx,
				role: turn.role,
				agent_response_ms: metric?.agentResponseMs ?? null,
				ttft_ms: metric?.ttftMs ?? null,
				interrupted: metric?.interrupted ?? false,
			};
		});
}

/**
 * Pure metric computation — extracted so the unit test can drive it with
 * synthetic fixtures, no store required.
 */
export function computeMetrics(
	replayId: string,
	turns: readonly ReplayTurnRow[],
	segments: readonly SpeechSegmentRow[],
	ttftSpans: readonly SpanRow[],
	replayStartMs: number,
): Array<{
	replayId: string;
	turnIdx: number;
	agentResponseMs: number | null;
	ttftMs: number | null;
	interrupted: boolean;
	interruptionStartMs: number | null;
}> {
	const sorted = [...turns].sort((a, b) => a.idx - b.idx);
	return sorted.map((turn, i) => {
		const agentResponseMs = turn.role === "agent" ? agentResponseFor(turn, sorted, i) : null;
		const ttftMs = turn.role === "agent" ? ttftFor(turn, ttftSpans, replayStartMs) : null;
		const { interrupted, interruptionStartMs } = interruptionFor(turn, segments);
		return {
			replayId,
			turnIdx: turn.idx,
			agentResponseMs,
			ttftMs,
			interrupted,
			interruptionStartMs,
		};
	});
}

function agentResponseFor(
	turn: ReplayTurnRow,
	sorted: readonly ReplayTurnRow[],
	i: number,
): number | null {
	for (let j = i - 1; j >= 0; j--) {
		const prev = sorted[j];
		if (prev !== undefined && prev.role === "user") {
			const gap = turn.voiceStartMs - prev.voiceEndMs;
			return gap >= 0 ? gap : 0;
		}
	}
	return null;
}

function ttftFor(
	turn: ReplayTurnRow,
	ttftSpans: readonly SpanRow[],
	replayStartMs: number,
): number | null {
	if (!Number.isFinite(replayStartMs)) return null;
	let earliestOffsetMs: number | null = null;
	for (const span of ttftSpans) {
		const startMs = Date.parse(span.startedAt) - replayStartMs;
		if (!Number.isFinite(startMs)) continue;
		if (startMs < turn.turnStartMs || startMs >= turn.voiceStartMs) continue;
		if (earliestOffsetMs === null || startMs < earliestOffsetMs) {
			earliestOffsetMs = startMs;
		}
	}
	if (earliestOffsetMs === null) return null;
	return turn.voiceStartMs - earliestOffsetMs;
}

function interruptionFor(
	turn: ReplayTurnRow,
	segments: readonly SpeechSegmentRow[],
): { interrupted: boolean; interruptionStartMs: number | null } {
	const opposite = turn.role === "user" ? "agent" : "user";
	for (const seg of segments) {
		if (seg.channel !== opposite) continue;
		if (seg.startMs >= turn.voiceStartMs && seg.startMs < turn.voiceEndMs) {
			return { interrupted: true, interruptionStartMs: seg.startMs };
		}
	}
	return { interrupted: false, interruptionStartMs: null };
}
