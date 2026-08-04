import { asc, eq } from "drizzle-orm";

import { getConversationSpec } from "@/server/conversations/conversations.service.ts";
import type { ReplayEvents } from "@/server/replays/replays.events.ts";
import { findReplay, markReplayFailed } from "@/server/replays/replays.service.ts";
import type { ReplayResult } from "@/server/replays/replays.types.ts";
import { projectTurnMetrics } from "@/server/replays/turn-metrics.ts";
import { replayEvaluations, replayMetrics, replays, replayTurns } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type { ReplayTurnRow } from "@/server/store/types.ts";

import type { JobRunner } from "../jobs.bunqueue.ts";
import { JobProcessingError } from "../jobs.errors.ts";
import type { JobPayload } from "../jobs.types.ts";

/**
 * Minimum opposite-side speech that counts as a barge-in, measured over the
 * whole utterance (the derived turn). Without a floor, VAD segments as short as
 * 80ms meant a cough or a backchannel "mm-hmm" started the yield clock and an
 * agent that correctly kept talking was billed for the whole remainder of its
 * answer.
 *
 * 500ms matches LiveKit's own `min_interruption_duration` default — the speech a
 * real agent waits for before it treats sound as an interruption — and the turn
 * boundary floor in `audio.turns.ts`. Every real barge-in in the committed
 * fixtures clears it (shortest is 510ms).
 *
 * Soft floor, knowingly: a turn's extent spans the pauses inside it, so speech
 * totalling less than this can still clear it — two 150ms phrases 400ms apart
 * are one 700ms turn carrying 300ms of sound. That is the deliberate direction
 * to err, because the alternative missed real interruptions: a barge-in said
 * with a beat in the middle is still a barge-in. Measuring actual voiced time
 * would need per-segment voiced duration out of the VAD, a schema change.
 */
const MIN_INTERRUPTION_MS = 500;

export interface CalculateMetricsResult {
	readonly ok: true;
	readonly metricsWritten: number;
}

export type CalculateMetricsProcessor = (payload: JobPayload) => Promise<CalculateMetricsResult>;

/**
 * Stage 2 of the analyze chain. Reads the VAD-derived turns, computes per-turn
 * timing metrics, writes `replay_metrics`. For a scripted replay it then bumps analysis_step to
 * `metrics` and enqueues `evaluate-replay`. For a live replay there's no
 * script to evaluate, so this stage is terminal: it finalizes in the same
 * transaction (writes an empty `replay_evaluations` row + flips lifecycle
 * to `completed`) and emits `evaluation_complete` directly.
 *
 * Metrics computed (all are audio-frame — every operand comes from VAD on
 * the same recording, so no cross-clock correlation is involved):
 * - `agentResponseMs` (agent turns only): gap from the prior user turn's
 *   `voice_end_ms` to this turn's `voice_start_ms`. Null for user turns
 *   and for the first agent turn when no prior user turn exists.
 * - `interrupted`: true iff an opposite-role turn of at least
 *   `MIN_INTERRUPTION_MS` started while this turn was still active.
 * - `interruptionStartMs`: the start of that overlap, when present.
 * - `yieldMs`: how long this turn kept talking after the interruption
 *   began (`voice_end_ms - interruption_start_ms`); null when the turn
 *   wasn't interrupted. This is the barge-in "time to yield the floor".
 *
 * Model TTFT is NOT computed here — it's an optional span attribute on
 * `model_usage.ttft_ms`, surfaced on the timeline.
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
			const rows = computeMetrics(replayId, turns);

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
					metrics: { turns: projectTurnMetrics(turns, rows) },
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

/**
 * Pure metric computation — extracted so the unit test can drive it with
 * synthetic fixtures, no store required.
 */
export function computeMetrics(
	replayId: string,
	turns: readonly ReplayTurnRow[],
): Array<{
	replayId: string;
	turnIdx: number;
	agentResponseMs: number | null;
	interrupted: boolean;
	interruptionStartMs: number | null;
	yieldMs: number | null;
}> {
	const sorted = [...turns].sort((a, b) => a.idx - b.idx);
	return sorted.map((turn, i) => {
		const agentResponseMs = turn.role === "agent" ? agentResponseFor(turn, sorted, i) : null;
		const { interrupted, interruptionStartMs } = interruptionFor(turn, sorted);
		// Time to yield the floor: from when the other side cut in to when this
		// turn's own voice stopped. Only defined when an interruption landed.
		const yieldMs =
			interruptionStartMs === null ? null : Math.max(0, turn.voiceEndMs - interruptionStartMs);
		return {
			replayId,
			turnIdx: turn.idx,
			agentResponseMs,
			interrupted,
			interruptionStartMs,
			yieldMs,
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

/**
 * Whether the other side cut into this turn, measured over their whole utterance
 * — the opposite-role *turn* — rather than over one VAD segment.
 *
 * A single segment is the wrong unit: VAD only bridges gaps up to its own
 * `mergeGapMs`, so one interruption said with a beat in the middle ("Wait—
 * stop!") arrives as two shorter segments and neither clears the floor on its
 * own. Turn derivation has already grouped those into one utterance, so reading
 * turns gets the grouping for free and — more importantly — can never disagree
 * with it. Re-deriving the grouping here from segments would be a second
 * implementation of `audio.turns.ts`, free to drift from it and reintroduce
 * exactly this bug.
 */
function interruptionFor(
	turn: ReplayTurnRow,
	turns: readonly ReplayTurnRow[],
): { interrupted: boolean; interruptionStartMs: number | null } {
	const opposite = turn.role === "user" ? "agent" : "user";
	// Earliest onset, not first-iterated: yieldMs runs from when the floor was
	// first contested, and two opposite turns can both start inside this one.
	let earliest: number | null = null;
	for (const other of turns) {
		if (other.role !== opposite) continue;
		if (other.voiceEndMs - other.voiceStartMs < MIN_INTERRUPTION_MS) continue;
		if (other.voiceStartMs >= turn.voiceStartMs && other.voiceStartMs < turn.voiceEndMs) {
			earliest = earliest === null ? other.voiceStartMs : Math.min(earliest, other.voiceStartMs);
		}
	}
	return earliest === null
		? { interrupted: false, interruptionStartMs: null }
		: { interrupted: true, interruptionStartMs: earliest };
}
