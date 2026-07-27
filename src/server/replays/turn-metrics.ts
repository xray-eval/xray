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
	readonly yieldMs: number | null;
}

/**
 * Project per-turn timing into the `TurnMetricsResponse` wire shape: one row
 * per turn, ordered by idx, joined to `replay_metrics` by turn idx (defaults
 * fire when the metrics stage hasn't written that turn's row yet).
 *
 * The single source of truth for this projection — the replay-detail read, the
 * scripted SSE payload, and the live-replay SSE payload all call it. One
 * function is what keeps those payloads byte-identical; hand-copied versions
 * drift.
 *
 * Structurally typed over its inputs so both the persisted `ReplayMetricRow`
 * and calculate-metrics' freshly-computed rows satisfy it without a conversion
 * step.
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
				yield_ms: m?.yieldMs ?? null,
			};
		});
}
