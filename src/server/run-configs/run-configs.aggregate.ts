import type { ReplayLifecycleState, TurnRole } from "@/server/store/types.ts";

import type {
	ConversationScope,
	InterruptionAggregate,
	MetricAggregate,
	PassAggregate,
	ReplaySelection,
	RunConfigMetrics,
	TokenAggregate,
} from "./run-configs.types.ts";

/**
 * Pure aggregation over rows already fetched from the store. No Drizzle, no
 * `Store` — everything here is a function of its arguments, which is what makes
 * the percentile and inclusion rules cheap to pin down in tests.
 */

const EMPTY_AGGREGATE: MetricAggregate = { avg: null, p50: null, p95: null, n: 0 };

/**
 * Nearest-rank percentile: `sorted[ceil(p/100 · n) − 1]`. Every result is a
 * value that was actually observed, so a p95 latency is a real turn someone can
 * go listen to — not an interpolation between two turns that never happened.
 *
 * SQLite has no percentile function and emulating one with window functions
 * costs more to verify than it saves; the sample sizes here are small enough
 * that sorting in TS is not the bottleneck.
 *
 * Returns null for an empty sample rather than 0 — "nothing measured" and
 * "measured zero" must not render the same.
 */
export function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
	return sorted[index] ?? null;
}

/**
 * Collapse a nullable metric column into one cell. `n` is the count of
 * non-null samples and travels with the numbers, because every source column
 * here is optional at capture time — TTFT only exists when the agent's
 * instrumentation emits it, `yield_ms` only when a turn was interrupted.
 */
export function aggregateMetric(values: readonly (number | null)[]): MetricAggregate {
	const present = values.filter((value): value is number => value !== null);
	if (present.length === 0) return EMPTY_AGGREGATE;
	const total = present.reduce((sum, value) => sum + value, 0);
	return {
		avg: Math.round(total / present.length),
		p50: percentile(present, 50),
		p95: percentile(present, 95),
		n: present.length,
	};
}

export interface IncludableReplay {
	readonly id: string;
	readonly conversationHash: string;
	readonly lifecycleState: ReplayLifecycleState;
	readonly startedAt: string;
}

/**
 * Decide which replays feed the aggregates. Only `completed` replays qualify —
 * a run that never finished analysis has no metrics to contribute.
 *
 * Under `latest`, one replay survives per conversation: the newest *completed*
 * one. A later failed run therefore does not displace an earlier good one,
 * which matters because the alternative would blank out a conversation's
 * numbers the moment a flaky run failed. Failed runs are surfaced separately as
 * a count, so they stay visible without corrupting the metrics.
 *
 * Ties on `started_at` break on id, so repeated calls return the same replay
 * and the drill-down link doesn't flip between renders.
 *
 * Returns newest-first.
 */
export function selectIncludedReplays<T extends IncludableReplay>(
	replays: readonly T[],
	selection: ReplaySelection,
): T[] {
	const completed = replays
		.filter((replay) => replay.lifecycleState === "completed")
		.sort(compareNewestFirst);
	if (selection === "all") return completed;
	const seen = new Set<string>();
	return completed.filter((replay) => {
		if (seen.has(replay.conversationHash)) return false;
		seen.add(replay.conversationHash);
		return true;
	});
}

function compareNewestFirst(a: IncludableReplay, b: IncludableReplay): number {
	if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface ConversationScopeResult {
	/** Conversation hashes whose replays may contribute to aggregates. */
	readonly included: ReadonlySet<string>;
	readonly unionCount: number;
	readonly intersectionCount: number;
}

/**
 * Work out which conversations count, given what each selected config actually
 * ran. Both counts are always reported: the gap between them is the whole
 * fair-comparison signal — "config A ran 15 conversations, config B ran the 3
 * easiest" is invisible if the UI only ever sees one number.
 *
 * `intersection` scope narrows aggregates to conversations every config
 * completed, so the averages are computed over the same workload.
 */
export function conversationScopeFilter(
	perConfigConversations: readonly (readonly string[])[],
	scope: ConversationScope,
): ConversationScopeResult {
	const union = new Set<string>();
	for (const hashes of perConfigConversations) {
		for (const hash of hashes) union.add(hash);
	}
	const intersection = new Set(
		[...union].filter((hash) =>
			perConfigConversations.every((hashes) => new Set(hashes).has(hash)),
		),
	);
	return {
		included: scope === "intersection" ? intersection : union,
		unionCount: union.size,
		// An empty selection has no shared workload; `every` over zero configs
		// would otherwise claim every conversation is shared by all of them.
		intersectionCount: perConfigConversations.length === 0 ? 0 : intersection.size,
	};
}

export interface TurnMetricSample {
	readonly replayId: string;
	readonly role: TurnRole;
	readonly agentResponseMs: number | null;
	readonly interrupted: boolean;
	readonly yieldMs: number | null;
}

export interface ModelUsageSample {
	readonly replayId: string;
	readonly ttftMs: number | null;
	readonly latencyMs: number | null;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
}

export interface EvaluationSample {
	readonly replayId: string;
	readonly passed: boolean;
}

export interface AggregateInput {
	/** The replays that count — already filtered by `selectIncludedReplays`. */
	readonly replays: readonly IncludableReplay[];
	readonly turnMetrics: readonly TurnMetricSample[];
	readonly modelUsage: readonly ModelUsageSample[];
	readonly evaluations: readonly EvaluationSample[];
}

/**
 * Project every metric for one set of included replays. Rows belonging to
 * replays outside that set are ignored, so callers can pass a single unfiltered
 * fetch per table and let this decide what counts.
 */
export function buildMetrics(input: AggregateInput): RunConfigMetrics {
	const includedIds = new Set(input.replays.map((replay) => replay.id));
	const turnMetrics = input.turnMetrics.filter((row) => includedIds.has(row.replayId));
	const modelUsage = input.modelUsage.filter((row) => includedIds.has(row.replayId));
	const evaluations = input.evaluations.filter((row) => includedIds.has(row.replayId));

	// `agent_response_ms` is null on user turns by construction, but filter on
	// role anyway so the interruption denominator and this sample can't drift
	// apart if that ever changes.
	const agentTurns = turnMetrics.filter((row) => row.role === "agent");

	return {
		ttft_ms: aggregateMetric(modelUsage.map((row) => row.ttftMs)),
		agent_response_ms: aggregateMetric(agentTurns.map((row) => row.agentResponseMs)),
		model_latency_ms: aggregateMetric(modelUsage.map((row) => row.latencyMs)),
		// Only interrupted turns have a yield time; the rest are absent samples,
		// not zeros, or "time to yield the floor" would trend toward zero as the
		// agent got *better* at not being interrupted.
		yield_ms: aggregateMetric(
			agentTurns.filter((row) => row.interrupted).map((row) => row.yieldMs),
		),
		interruption: buildInterruption(agentTurns),
		tokens: buildTokens(modelUsage),
		pass: buildPass(evaluations),
	};
}

function buildInterruption(agentTurns: readonly TurnMetricSample[]): InterruptionAggregate {
	return {
		interrupted_turns: agentTurns.filter((row) => row.interrupted).length,
		agent_turns: agentTurns.length,
	};
}

/**
 * Tokens are summed within a replay before averaging across replays: a replay
 * that made 8 model calls burned more than one that made 2, and a per-row mean
 * would hide exactly that difference. `n` counts replays that emitted usage at
 * all, so a config whose agent isn't instrumented reads as "no data".
 */
function buildTokens(modelUsage: readonly ModelUsageSample[]): TokenAggregate {
	const perReplay = new Map<string, { input: number; output: number }>();
	for (const row of modelUsage) {
		const totals = perReplay.get(row.replayId) ?? { input: 0, output: 0 };
		totals.input += row.inputTokens ?? 0;
		totals.output += row.outputTokens ?? 0;
		perReplay.set(row.replayId, totals);
	}
	if (perReplay.size === 0) {
		return { avg_input: null, avg_output: null, avg_total: null, n: 0 };
	}
	const totals = [...perReplay.values()];
	const avgInput = Math.round(totals.reduce((s, t) => s + t.input, 0) / totals.length);
	const avgOutput = Math.round(totals.reduce((s, t) => s + t.output, 0) / totals.length);
	return {
		avg_input: avgInput,
		avg_output: avgOutput,
		avg_total: avgInput + avgOutput,
		n: totals.length,
	};
}

/** Denominator is replays that were actually evaluated, not all included ones. */
function buildPass(evaluations: readonly EvaluationSample[]): PassAggregate {
	return {
		passed: evaluations.filter((row) => row.passed).length,
		total: evaluations.length,
	};
}
