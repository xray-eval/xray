import { and, asc, eq } from "drizzle-orm";

import type { ReplayEvents } from "@/server/replays/replays.events.ts";
import { findReplay, markReplayFailed } from "@/server/replays/replays.service.ts";
import {
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
 * `replay_metrics`, transitions analysis_step to `evaluate`, then
 * enqueues `evaluate-replay`.
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

			const advanced = store.db.transaction((tx) => {
				// Same idempotency rule as analyze-replay: don't trash existing
				// metric rows if a concurrent path already flipped lifecycle to
				// `failed` or `completed`. Read the lifecycle first; abort the
				// write phase otherwise.
				const current = tx.select().from(replays).where(eq(replays.id, replayId)).get();
				if (current?.lifecycleState !== "analyzing") return false;

				tx.delete(replayMetrics).where(eq(replayMetrics.replayId, replayId)).run();
				if (rows.length > 0) tx.insert(replayMetrics).values(rows).run();
				tx.update(replays).set({ analysisStep: "metrics" }).where(eq(replays.id, replayId)).run();
				return true;
			});

			if (!advanced) {
				console.warn(
					`calculate-metrics worker for ${replayId} found the row no longer in 'analyzing' — skipping chain`,
				);
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
