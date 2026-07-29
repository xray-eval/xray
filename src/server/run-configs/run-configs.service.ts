import { and, count, countDistinct, eq, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";

import {
	conversations,
	modelUsage,
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	runConfigs,
} from "@/server/store/schema.ts";
import type { Store, StoreDbOrTx } from "@/server/store/store.ts";
import type { RunConfigRow } from "@/server/store/types.ts";

import type {
	EvaluationSample,
	IncludableReplay,
	ModelUsageSample,
	TurnMetricSample,
} from "./run-configs.aggregate.ts";
import {
	buildMetrics,
	conversationScopeFilter,
	selectIncludedReplays,
} from "./run-configs.aggregate.ts";
import { RunConfigNotFoundError } from "./run-configs.errors.ts";
import { canonicalRunConfigJson, hashRunConfig } from "./run-configs.hash.ts";
import type {
	CompareRunConfigsRequest,
	CompareRunConfigsResponse,
	ListRunConfigsResponse,
	ReplaySelection,
	RunConfigConversationRow,
	RunConfigCoverage,
	RunConfigDetailResponse,
	RunConfigGroupResult,
	RunConfigSummary,
} from "./run-configs.types.ts";

export interface EnsureRunConfigInput {
	readonly config: unknown;
	readonly name?: string;
	readonly now: string;
}

/**
 * Idempotent upsert of a run-config group keyed by content hash. Inserts on
 * first sight, else applies the display label.
 *
 * Two deliberate differences from `ensureConversation`:
 *
 * 1. An **unnamed** write never erases an existing label. `name` is required
 *    on conversations but optional here, so "no name" means "the caller said
 *    nothing about the label", not "the label is now empty" — otherwise every
 *    run by a dev who omits `RunConfig(name=...)` would strip the label a
 *    teammate set.
 * 2. `created_at` is not touched on upsert: a group is as old as its first
 *    run, and there's no `last_run_at` to bump because that's derivable from
 *    the replays pointing at it.
 *
 * `config_json` stores the *canonical* encoding, not the caller's byte order,
 * so the group's rendered config is deterministic. The verbatim per-replay
 * copy stays on `replays.run_config_json`.
 *
 * Takes `StoreDb` or a transaction handle so `createReplay` can compose the
 * group upsert and the replay insert atomically.
 */
export function ensureRunConfig(db: StoreDbOrTx, input: EnsureRunConfigInput): RunConfigRow {
	const hash = hashRunConfig(input.config);
	const existing = db.select().from(runConfigs).where(eq(runConfigs.hash, hash)).get();
	if (existing !== undefined) {
		if (input.name === undefined || input.name === existing.name) return existing;
		db.update(runConfigs).set({ name: input.name }).where(eq(runConfigs.hash, hash)).run();
		return { ...existing, name: input.name };
	}
	const row: RunConfigRow = {
		hash,
		name: input.name ?? null,
		configJson: canonicalRunConfigJson(input.config),
		createdAt: input.now,
	};
	db.insert(runConfigs).values(row).run();
	return row;
}

export interface BackfillRunConfigsOptions {
	now?: () => string;
}

/**
 * Assign a group to every replay that carries a `run_config` but no hash —
 * i.e. every replay created before run configs had an identity. Returns the
 * number of replays grouped.
 *
 * This can't live in the migration SQL: SQLite has no SHA-256, so the hash has
 * to be computed in application code. Called once at startup, idempotent, so a
 * restart after a partial run finishes the job.
 *
 * Legacy groups come out unnamed — the label was never sent, so there is
 * nothing to recover. A corrupt `run_config_json` is skipped with a warning
 * rather than aborting: one unparseable row must not stop the server from
 * booting. Same degrade-don't-throw stance as `parseStoredSpec`.
 */
export function backfillRunConfigs(store: Store, opts: BackfillRunConfigsOptions = {}): number {
	const now = opts.now ?? (() => new Date().toISOString());
	const pending = store.db
		.select({ id: replays.id, runConfigJson: replays.runConfigJson })
		.from(replays)
		.where(and(isNotNull(replays.runConfigJson), isNull(replays.runConfigHash)))
		.all();

	const grouped: string[] = [];
	store.db.transaction((tx) => {
		for (const row of pending) {
			const config = parseLegacyRunConfig(row.id, row.runConfigJson);
			if (config === undefined) continue;
			const group = ensureRunConfig(tx, { config, now: now() });
			tx.update(replays).set({ runConfigHash: group.hash }).where(eq(replays.id, row.id)).run();
			grouped.push(row.id);
		}
	});
	return grouped.length;
}

/**
 * `undefined` means "this replay gets no group": either the column was null,
 * held an explicit JSON `null` (treated the same as absent, matching
 * `POST /v1/replays`), or could not be parsed.
 */
function parseLegacyRunConfig(replayId: string, raw: string | null): unknown {
	if (raw === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null) return undefined;
		// Canonicalize eagerly so a value the encoder rejects is caught here,
		// where it degrades to a skip, rather than inside the transaction.
		canonicalRunConfigJson(parsed);
		return parsed;
	} catch (err) {
		console.warn(
			"[run-configs] skipping backfill for replay=%s: run_config_json is not canonicalizable. err=%s",
			replayId,
			err instanceof Error ? err.message : String(err),
		);
		return undefined;
	}
}

type GroupedReplayRow = IncludableReplay & { readonly runConfigHash: string };

/**
 * Replay headers for the given groups — the input to selection and to the
 * coverage counts. Headers, not derived rows: which replays count is decided in
 * pure code afterwards, and only then are their metrics read.
 *
 * Deliberately unfiltered by lifecycle: `coverage.failed_replays` is counted
 * over the whole group, so a config that fails runs outright stays visible.
 */
function fetchGroupReplays(store: Store, hashes: readonly string[]): GroupedReplayRow[] {
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
interface DerivedRows {
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
function fetchDerivedRows(store: Store, replayIds: readonly string[]): DerivedRows {
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
				})
				.from(modelUsage)
				.where(inArray(modelUsage.replayId, ids))
				.all(),
		);

		evaluations.push(
			...store.db
				.select({ replayId: replayEvaluations.replayId, passed: replayEvaluations.passed })
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

function narrowToGroup<T extends { readonly runConfigHash: string }>(
	rows: readonly T[],
	hash: string,
): T[] {
	return rows.filter((row) => row.runConfigHash === hash);
}

function coverageOf(
	groupReplays: readonly (IncludableReplay & { runConfigHash: string })[],
	includedReplays: readonly IncludableReplay[],
): RunConfigCoverage {
	return {
		conversations: new Set(includedReplays.map((r) => r.conversationHash)).size,
		replays: includedReplays.length,
		// Counted across the whole group regardless of selection mode: a config
		// that fails runs outright is signal, and hiding it behind "latest
		// completed" would make a broken strategy look merely under-covered.
		failed_replays: groupReplays.filter((r) => r.lifecycleState === "failed").length,
	};
}

function parseStoredConfig(row: RunConfigRow): unknown {
	try {
		return JSON.parse(row.configJson);
	} catch (err) {
		console.warn(
			"[run-configs] config_json JSON.parse failed for hash=%s; rendering as null. err=%s",
			row.hash,
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
}

interface GroupCoverageCounts {
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
function fetchGroupCoverage(store: Store): Map<string, GroupCoverageCounts> {
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

/**
 * All groups, newest activity first, each with the coverage counts the picker
 * needs to show what a group actually spans before you select it.
 *
 * Coverage here is deliberately over *every* replay in the group, not the
 * `latest`-per-conversation subset — this is the "how much has this config
 * been exercised" number, and the comparison view recomputes per selection.
 */
export function listRunConfigs(store: Store): ListRunConfigsResponse {
	const groups = store.db.select().from(runConfigs).all();
	if (groups.length === 0) return { items: [] };
	const coverage = fetchGroupCoverage(store);
	const items: RunConfigSummary[] = groups.map((group) => {
		// A group no replay points at still belongs in the list — it exists, and
		// zeros are the honest reading of it.
		const counts = coverage.get(group.hash);
		return {
			hash: group.hash,
			name: group.name,
			config: parseStoredConfig(group),
			created_at: group.createdAt,
			last_run_at: counts?.lastRunAt ?? null,
			coverage: {
				conversations: counts?.conversations ?? 0,
				replays: counts?.replays ?? 0,
				failed_replays: counts?.failedReplays ?? 0,
			},
		};
	});
	items.sort((a, b) => {
		const ax = a.last_run_at ?? a.created_at;
		const bx = b.last_run_at ?? b.created_at;
		return ax < bx ? 1 : ax > bx ? -1 : 0;
	});
	return { items };
}

/**
 * Compare 2..n groups on the same metric set.
 *
 * Throws `RunConfigNotFoundError` for the first unknown hash: silently dropping
 * it would render a comparison with fewer columns than the caller asked for,
 * which reads as "this config has no data" rather than "this config
 * doesn't exist".
 */
export function compareRunConfigs(
	store: Store,
	req: CompareRunConfigsRequest,
): CompareRunConfigsResponse {
	const groups = req.config_hashes.map((hash) => requireGroup(store, hash));
	const replayRows = fetchGroupReplays(store, req.config_hashes);

	// Included replays are resolved before scope is applied, because the scope
	// itself is defined by what each config *completed* — a conversation only
	// one config finished isn't shared workload even if both attempted it.
	const perGroupIncluded = groups.map((group) =>
		selectIncludedReplays(narrowToGroup(replayRows, group.hash), req.replay_selection),
	);
	const scope = conversationScopeFilter(
		perGroupIncluded.map((included) => [...new Set(included.map((r) => r.conversationHash))]),
		req.conversation_scope,
	);
	const perGroupScoped = perGroupIncluded.map((included) =>
		included.filter((replay) => scope.included.has(replay.conversationHash)),
	);
	// Read after selection and scope, so the derived tables are touched only for
	// replays that actually feed a number.
	const derived = fetchDerivedRows(
		store,
		perGroupScoped.flatMap((included) => included.map((replay) => replay.id)),
	);

	const groupResults: RunConfigGroupResult[] = groups.map((group, idx) => {
		const included = perGroupScoped[idx] ?? [];
		return {
			hash: group.hash,
			name: group.name,
			config: parseStoredConfig(group),
			coverage: coverageOf(narrowToGroup(replayRows, group.hash), included),
			// `buildMetrics` keys off `included`, so rows belonging to another
			// group's replays drop out here — no need to pre-partition by hash.
			metrics: buildMetrics({ replays: included, ...derived }),
		};
	});

	return {
		replay_selection: req.replay_selection,
		conversation_scope: req.conversation_scope,
		union_conversations: scope.unionCount,
		intersection_conversations: scope.intersectionCount,
		groups: groupResults,
	};
}

/**
 * One group across all the conversations it ran — the drill-down. Each
 * conversation row carries its newest included replay so the UI can link
 * straight to the inspector and the run can be listened to. Under `all`
 * selection the row's metrics span every replay in `replays`, not just that one.
 *
 * Throws `RunConfigNotFoundError` on an unknown hash.
 */
export function getRunConfigDetail(
	store: Store,
	hash: string,
	selection: ReplaySelection,
): RunConfigDetailResponse {
	const group = requireGroup(store, hash);
	const groupReplays = fetchGroupReplays(store, [hash]);
	const included = selectIncludedReplays(groupReplays, selection);
	const derived = fetchDerivedRows(
		store,
		included.map((replay) => replay.id),
	);
	const names = conversationNames(
		store,
		included.map((r) => r.conversationHash),
	);

	const byConversation = new Map<string, typeof included>();
	for (const replay of included) {
		byConversation.set(replay.conversationHash, [
			...(byConversation.get(replay.conversationHash) ?? []),
			replay,
		]);
	}
	const passedById = new Map(derived.evaluations.map((row) => [row.replayId, row.passed] as const));

	const conversationRows: RunConfigConversationRow[] = [];
	for (const [conversationHash, conversationReplays] of byConversation) {
		// `selectIncludedReplays` returns newest-first, so index 0 is the replay
		// whose numbers this row shows under `latest` selection and the newest
		// run under `all`.
		const primary = conversationReplays[0];
		if (primary === undefined) continue;
		conversationRows.push({
			conversation_hash: conversationHash,
			conversation_name: names.get(conversationHash) ?? conversationHash.slice(0, 12),
			replay_id: primary.id,
			replays: conversationReplays.map((replay) => ({
				id: replay.id,
				started_at: replay.startedAt,
				passed: passedById.get(replay.id) ?? null,
			})),
			metrics: buildMetrics({ replays: conversationReplays, ...derived }),
		});
	}
	conversationRows.sort((a, b) => a.conversation_name.localeCompare(b.conversation_name));

	return {
		hash: group.hash,
		name: group.name,
		config: parseStoredConfig(group),
		created_at: group.createdAt,
		replay_selection: selection,
		coverage: coverageOf(groupReplays, included),
		metrics: buildMetrics({ replays: included, ...derived }),
		conversations: conversationRows,
	};
}

function requireGroup(store: Store, hash: string): RunConfigRow {
	const row = store.db.select().from(runConfigs).where(eq(runConfigs.hash, hash)).get();
	if (row === undefined) throw new RunConfigNotFoundError(hash);
	return row;
}

function conversationNames(store: Store, hashes: readonly string[]): Map<string, string> {
	if (hashes.length === 0) return new Map();
	const rows = store.db
		.select({ hash: conversations.hash, name: conversations.name })
		.from(conversations)
		.where(inArray(conversations.hash, [...new Set(hashes)]))
		.all();
	return new Map(rows.map((row) => [row.hash, row.name] as const));
}
