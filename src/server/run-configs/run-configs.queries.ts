import { and, count, countDistinct, eq, inArray, isNotNull, max, sql } from "drizzle-orm";

import {
	conversations,
	modelUsage,
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	runConfigs,
} from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type { RunConfigRow } from "@/server/store/types.ts";

import type {
	EvaluationSample,
	IncludableReplay,
	ModelUsageSample,
	TurnMetricSample,
} from "./run-configs.aggregate.ts";
import { RunConfigNotFoundError } from "./run-configs.errors.ts";

/**
 * Every SQLite read the comparison endpoints make. Nothing here decides what a
 * number *means* — that's `run-configs.aggregate.ts`, which is pure — and
 * nothing here writes: group membership lives in `run-configs.groups.ts`.
 */

export type GroupedReplayRow = IncludableReplay & { readonly runConfigHash: string };

/**
 * Replay headers for the given groups — the input to selection and to the
 * coverage counts. Headers, not derived rows: which replays count is decided in
 * pure code afterwards, and only then are their metrics read.
 *
 * Deliberately unfiltered by lifecycle: `coverage.failed_replays` is counted
 * over the whole group, so a config that fails runs outright stays visible.
 */
export function fetchGroupReplays(store: Store, hashes: readonly string[]): GroupedReplayRow[] {
	if (hashes.length === 0) return [];
	return store.db
		.select({
			id: replays.id,
			conversationHash: replays.conversationHash,
			lifecycleState: replays.lifecycleState,
			startedAt: replays.startedAt,
			runConfigHash: replays.runConfigHash,
		})
		.from(replays)
		.where(inArray(replays.runConfigHash, [...hashes]))
		.all()
		.filter(hasGroup);
}

/** The derived rows the aggregates read, for one explicit set of replays. */
export interface DerivedRows {
	readonly turnMetrics: readonly TurnMetricSample[];
	readonly modelUsage: readonly ModelUsageSample[];
	readonly evaluations: readonly EvaluationSample[];
}

const REPLAY_ID_BATCH = 500;

/**
 * Batch an id list for `IN (…)`, de-duplicated.
 *
 * The de-duplication is load-bearing rather than tidiness: an id appearing in
 * two batches would fetch its rows twice, and every aggregate below sums what
 * it's handed.
 */
export function chunkIds(ids: readonly string[], size: number): string[][] {
	const unique = [...new Set(ids)];
	const batches: string[][] = [];
	for (let start = 0; start < unique.length; start += size) {
		batches.push(unique.slice(start, start + size));
	}
	return batches;
}

/**
 * Read the derived rows for exactly the replays that feed a number.
 *
 * Keyed by replay id, not by `run_config_hash`, because the useful subset and
 * the group's history diverge: under the default `latest` selection one replay
 * per conversation feeds the metrics no matter how many times the suite has been
 * re-run, so fetching by group would grow every page load with the whole run
 * history only for `buildMetrics` to discard the surplus.
 *
 * Ids are batched because under `all` selection the list *does* grow with the
 * history, and an unbounded `IN` would eventually reach SQLite's bound-variable
 * ceiling.
 */
export function fetchDerivedRows(store: Store, replayIds: readonly string[]): DerivedRows {
	const turnMetrics: TurnMetricSample[] = [];
	const modelUsageRows: ModelUsageSample[] = [];
	const evaluations: EvaluationSample[] = [];

	for (const ids of chunkIds(replayIds, REPLAY_ID_BATCH)) {
		// `replay_metrics` has no role column, so the agent-turn filter and the
		// interruption denominator both need the join to `replay_turns` — same
		// pairing `projectTurnMetrics` does for the per-replay view.
		turnMetrics.push(
			...store.db
				.select({
					replayId: replayMetrics.replayId,
					role: replayTurns.role,
					agentResponseMs: replayMetrics.agentResponseMs,
					interrupted: replayMetrics.interrupted,
					yieldMs: replayMetrics.yieldMs,
				})
				.from(replayMetrics)
				.innerJoin(
					replayTurns,
					and(
						eq(replayTurns.replayId, replayMetrics.replayId),
						eq(replayTurns.idx, replayMetrics.turnIdx),
					),
				)
				.where(inArray(replayMetrics.replayId, ids))
				.all(),
		);

		modelUsageRows.push(
			...store.db
				.select({
					replayId: modelUsage.replayId,
					ttftMs: modelUsage.ttftMs,
					latencyMs: modelUsage.latencyMs,
					inputTokens: modelUsage.inputTokens,
					outputTokens: modelUsage.outputTokens,
					// Independent of the split, not derived from it: Langfuse reads all
					// three from separate attributes, so a row can carry a total alone.
					totalTokens: modelUsage.totalTokens,
				})
				.from(modelUsage)
				.where(inArray(modelUsage.replayId, ids))
				.all(),
		);

		evaluations.push(
			...store.db
				.select({
					replayId: replayEvaluations.replayId,
					passed: replayEvaluations.passed,
					assertionsPassed: replayEvaluations.assertionsPassed,
					assertionsTotal: replayEvaluations.assertionsTotal,
					judgesPassed: replayEvaluations.judgesPassed,
					judgesTotal: replayEvaluations.judgesTotal,
				})
				.from(replayEvaluations)
				.where(inArray(replayEvaluations.replayId, ids))
				.all(),
		);
	}

	return { turnMetrics, modelUsage: modelUsageRows, evaluations };
}

/**
 * Narrows the nullable `run_config_hash` the join carries. The `IN` filter
 * already excluded nulls, but the column's type doesn't know that.
 */
function hasGroup<T extends { runConfigHash: string | null }>(
	row: T,
): row is T & { runConfigHash: string } {
	return row.runConfigHash !== null;
}

export interface GroupCoverageCounts {
	readonly conversations: number;
	readonly replays: number;
	readonly failedReplays: number;
	readonly lastRunAt: string | null;
}

/**
 * Coverage for every group, counted in SQL and keyed by hash.
 *
 * Aggregated by the database rather than over fetched rows so a page load stays
 * independent of the run history: the alternative reads every grouped replay
 * header in the file to produce three integers per group, and builds an `IN`
 * clause that grows with the number of groups — which a two-parameter sweep
 * produces quickly.
 */
export function fetchGroupCoverage(store: Store): Map<string, GroupCoverageCounts> {
	const rows = store.db
		.select({
			hash: replays.runConfigHash,
			replayCount: count(),
			conversationCount: countDistinct(replays.conversationHash),
			// `count(expr)` skips nulls, so a CASE with no ELSE counts exactly the
			// failed rows — and returns an integer, where `sum` would come back as a
			// string.
			failedCount: count(sql`case when ${replays.lifecycleState} = 'failed' then 1 end`),
			lastRunAt: max(replays.startedAt),
		})
		.from(replays)
		.where(isNotNull(replays.runConfigHash))
		.groupBy(replays.runConfigHash)
		.all();

	const byHash = new Map<string, GroupCoverageCounts>();
	for (const row of rows) {
		// The `IS NOT NULL` filter already excluded ungrouped replays; the column's
		// type doesn't know that.
		if (row.hash === null) continue;
		byHash.set(row.hash, {
			conversations: row.conversationCount,
			replays: row.replayCount,
			failedReplays: row.failedCount,
			lastRunAt: row.lastRunAt,
		});
	}
	return byHash;
}

export function listGroups(store: Store): RunConfigRow[] {
	return store.db.select().from(runConfigs).all();
}

/** Throws `RunConfigNotFoundError` rather than returning undefined. */
export function requireGroup(store: Store, hash: string): RunConfigRow {
	const row = store.db.select().from(runConfigs).where(eq(runConfigs.hash, hash)).get();
	if (row === undefined) throw new RunConfigNotFoundError(hash);
	return row;
}

export function conversationNames(store: Store, hashes: readonly string[]): Map<string, string> {
	if (hashes.length === 0) return new Map();
	const rows = store.db
		.select({ hash: conversations.hash, name: conversations.name })
		.from(conversations)
		.where(inArray(conversations.hash, [...new Set(hashes)]))
		.all();
	return new Map(rows.map((row) => [row.hash, row.name] as const));
}
