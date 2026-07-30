import type { MetricAggregate, RunConfigMetrics } from "@/client/api/api.types.ts";
import { formatDurationMs } from "@/client/format.ts";

/**
 * Which direction counts as an improvement. `none` means the tool refuses to
 * call a winner — see `METRIC_ROWS` for why interruption rate and token usage
 * are deliberately unranked.
 */
export type BetterDirection = "lower" | "higher" | "none";

export interface MetricCell {
	/** Comparable magnitude, or null when nothing was measured. */
	readonly value: number | null;
	readonly display: string;
	/** Secondary line: percentiles, or the counts behind a percentage. */
	readonly detail: string | null;
	/** Sample size, rendered so a mean over 3 can't pass for a mean over 300. */
	readonly n: number;
}

export interface MetricRow {
	readonly key: string;
	readonly label: string;
	readonly unit: string;
	readonly better: BetterDirection;
	readonly read: (metrics: RunConfigMetrics) => MetricCell;
}

const EMPTY_CELL: MetricCell = { value: null, display: "—", detail: null, n: 0 };

function latencyCell(aggregate: MetricAggregate): MetricCell {
	if (aggregate.avg === null) return { ...EMPTY_CELL, n: aggregate.n };
	const parts: string[] = [];
	if (aggregate.p50 !== null) parts.push(`p50 ${formatDurationMs(aggregate.p50)}`);
	if (aggregate.p95 !== null) parts.push(`p95 ${formatDurationMs(aggregate.p95)}`);
	return {
		value: aggregate.avg,
		display: formatDurationMs(aggregate.avg),
		detail: parts.length > 0 ? parts.join(" · ") : null,
		n: aggregate.n,
	};
}

function ratioCell(numerator: number, denominator: number, noun: string): MetricCell {
	if (denominator === 0) return EMPTY_CELL;
	const ratio = numerator / denominator;
	return {
		value: ratio,
		display: `${Math.round(ratio * 100)}%`,
		detail: `${numerator} of ${denominator} ${noun}`,
		n: denominator,
	};
}

/**
 * The rows of the comparison matrix, in reading order: what the agent's
 * latency looks like, then how it behaves under interruption, then what it
 * costs, then whether it was actually correct.
 *
 * Interruption rate and token usage are `none` on purpose. A higher
 * interruption rate can mean the agent is too slow *or* that the test script
 * barges in more; fewer tokens can mean a cheaper agent *or* a lazier one.
 * Ranking them would put a judgement in the UI that the data doesn't support.
 */
export const METRIC_ROWS: readonly MetricRow[] = [
	{
		key: "ttft_ms",
		label: "Model TTFT",
		unit: "time to first token",
		better: "lower",
		read: (m) => latencyCell(m.ttft_ms),
	},
	{
		key: "agent_response_ms",
		label: "Voice-to-voice",
		unit: "silence before the agent speaks",
		better: "lower",
		read: (m) => latencyCell(m.agent_response_ms),
	},
	{
		key: "model_latency_ms",
		label: "Model call",
		unit: "full completion latency",
		better: "lower",
		read: (m) => latencyCell(m.model_latency_ms),
	},
	{
		key: "interruption",
		label: "Interrupted",
		unit: "share of agent turns barged in on",
		better: "none",
		read: (m) =>
			ratioCell(m.interruption.interrupted_turns, m.interruption.agent_turns, "agent turns"),
	},
	{
		key: "yield_ms",
		label: "Time to yield",
		unit: "how long it keeps talking after a barge-in",
		better: "lower",
		read: (m) => latencyCell(m.yield_ms),
	},
	{
		key: "tokens",
		label: "Tokens per replay",
		unit: "averaged over replays that reported usage",
		better: "none",
		read: (m) => {
			if (m.tokens.avg_total === null) return { ...EMPTY_CELL, n: m.tokens.n };
			// The split is null when no replay reported one — an agent can emit a
			// total alone. "0 in · 0 out" under a real total would invent a
			// measurement nobody took, so drop the line instead.
			const split =
				m.tokens.avg_input === null && m.tokens.avg_output === null
					? null
					: `${m.tokens.avg_input ?? 0} in · ${m.tokens.avg_output ?? 0} out`;
			return {
				value: m.tokens.avg_total,
				display: String(m.tokens.avg_total),
				detail: split,
				n: m.tokens.n,
			};
		},
	},
	{
		key: "pass",
		label: "Pass rate",
		unit: "replays whose assertions and judges all passed",
		better: "higher",
		read: (m) => ratioCell(m.pass.passed, m.pass.total, "replays"),
	},
];

/**
 * Index of the winning cell in a row, or null when there is no honest winner.
 *
 * Requires at least two measured cells and a strict win: a tie or a row where
 * only one config reported the metric gets no marker, because highlighting
 * "the only config that emitted TTFT" as the best would reward instrumentation
 * coverage rather than speed.
 */
export function bestCellIndex(
	values: readonly (number | null)[],
	better: BetterDirection,
): number | null {
	if (better === "none") return null;
	const measured = values
		.map((value, index) => ({ value, index }))
		.filter((entry): entry is { value: number; index: number } => entry.value !== null);
	if (measured.length < 2) return null;
	const winner = measured.reduce((best, entry) =>
		better === "lower"
			? entry.value < best.value
				? entry
				: best
			: entry.value > best.value
				? entry
				: best,
	);
	const ties = measured.filter((entry) => entry.value === winner.value);
	return ties.length > 1 ? null : winner.index;
}
