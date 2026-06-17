import type { TurnRole } from "@/server/store/types.ts";

import type { TurnMetricsResponse } from "./replays.types.ts";

interface TurnLike {
	readonly idx: number;
	readonly role: TurnRole;
}

interface TurnMetricLike {
	readonly turnIdx: number;
	readonly agentResponseMs: number | null;
	readonly interrupted: boolean;
	readonly interruptionStartMs: number | null;
}

/**
 * Project per-turn timing into the `TurnMetricsResponse` wire shape: one row
 * per turn, ordered by idx, with the matching `replay_metrics` values joined
 * by turn idx (the defaults fire when the metrics stage hasn't written a row
 * for that turn yet).
 *
 * The single source of truth for this projection. Every path that hands the
 * SDK or the inspector per-turn metrics calls it — the replay-detail read
 * (`buildTurnMetrics`), the scripted `evaluation_complete` SSE payload
 * (evaluate-replay), and the live-replay `evaluation_complete` SSE payload
 * (calculate-metrics). Keeping one function is what actually keeps those
 * payloads byte-identical; three hand-copied versions drift.
 *
 * Structurally typed over its inputs so both the persisted `ReplayMetricRow`
 * and calculate-metrics' freshly-computed (not-yet-read-back) metric rows
 * satisfy it without a conversion step.
 */
export function projectTurnMetrics(
	turns: readonly TurnLike[],
	metrics: readonly TurnMetricLike[],
): TurnMetricsResponse[] {
	const metricByTurnIdx = new Map(metrics.map((m) => [m.turnIdx, m]));
	return [...turns]
		.sort((a, b) => a.idx - b.idx)
		.map((turn) => {
			const m = metricByTurnIdx.get(turn.idx);
			return {
				turn_idx: turn.idx,
				role: turn.role,
				agent_response_ms: m?.agentResponseMs ?? null,
				interrupted: m?.interrupted ?? false,
				interruption_start_ms: m?.interruptionStartMs ?? null,
			};
		});
}
