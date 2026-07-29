import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

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
	AggregateInput,
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

/**
 * Every replay in the given groups, plus the derived rows the aggregates read.
 *
 * One fetch per table filtered by `run_config_hash IN (…)` — never by a list of
 * replay ids, which would grow an `IN` clause with the run history and risk
 * SQLite's bound-variable ceiling. Inclusion (latest vs all, scope) is decided
 * afterwards in pure code.
 */
interface GroupRows {
	readonly replays: readonly (IncludableReplay & { readonly runConfigHash: string })[];
	readonly turnMetrics: readonly (TurnMetricSample & { readonly runConfigHash: string })[];
	readonly modelUsage: readonly (ModelUsageSample & { readonly runConfigHash: string })[];
	readonly evaluations: readonly (EvaluationSample & { readonly runConfigHash: string })[];
}

function fetchGroupRows(store: Store, hashes: readonly string[]): GroupRows {
	if (hashes.length === 0) {
		return { replays: [], turnMetrics: [], modelUsage: [], evaluations: [] };
	}
	const inGroups = inArray(replays.runConfigHash, [...hashes]);
	const replayRows = store.db
		.select({
			id: replays.id,
			conversationHash: replays.conversationHash,
			lifecycleState: replays.lifecycleState,
			startedAt: replays.startedAt,
			runConfigHash: replays.runConfigHash,
		})
		.from(replays)
		.where(inGroups)
		.all();

	// `replay_metrics` has no role column, so the agent-turn filter and the
	// interruption denominator both need the join to `replay_turns` — same
	// pairing `projectTurnMetrics` does for the per-replay view.
	const turnMetricRows = store.db
		.select({
			replayId: replayMetrics.replayId,
			role: replayTurns.role,
			agentResponseMs: replayMetrics.agentResponseMs,
			interrupted: replayMetrics.interrupted,
			yieldMs: replayMetrics.yieldMs,
			runConfigHash: replays.runConfigHash,
		})
		.from(replayMetrics)
		.innerJoin(replays, eq(replays.id, replayMetrics.replayId))
		.innerJoin(
			replayTurns,
			and(
				eq(replayTurns.replayId, replayMetrics.replayId),
				eq(replayTurns.idx, replayMetrics.turnIdx),
			),
		)
		.where(inGroups)
		.all();

	const modelUsageRows = store.db
		.select({
			replayId: modelUsage.replayId,
			ttftMs: modelUsage.ttftMs,
			latencyMs: modelUsage.latencyMs,
			inputTokens: modelUsage.inputTokens,
			outputTokens: modelUsage.outputTokens,
			runConfigHash: replays.runConfigHash,
		})
		.from(modelUsage)
		.innerJoin(replays, eq(replays.id, modelUsage.replayId))
		.where(inGroups)
		.all();

	const evaluationRows = store.db
		.select({
			replayId: replayEvaluations.replayId,
			passed: replayEvaluations.passed,
			runConfigHash: replays.runConfigHash,
		})
		.from(replayEvaluations)
		.innerJoin(replays, eq(replays.id, replayEvaluations.replayId))
		.where(inGroups)
		.all();

	return {
		replays: replayRows.filter(hasGroup),
		turnMetrics: turnMetricRows.filter(hasGroup),
		modelUsage: modelUsageRows.filter(hasGroup),
		evaluations: evaluationRows.filter(hasGroup),
	};
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

function aggregateInputFor(
	rows: GroupRows,
	hash: string,
	includedReplays: readonly IncludableReplay[],
): AggregateInput {
	return {
		replays: includedReplays,
		turnMetrics: narrowToGroup(rows.turnMetrics, hash),
		modelUsage: narrowToGroup(rows.modelUsage, hash),
		evaluations: narrowToGroup(rows.evaluations, hash),
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
	const rows = fetchGroupRows(
		store,
		groups.map((g) => g.hash),
	);
	const items: RunConfigSummary[] = groups.map((group) => {
		const groupReplays = narrowToGroup(rows.replays, group.hash);
		const startedAts = groupReplays.map((r) => r.startedAt).sort();
		return {
			hash: group.hash,
			name: group.name,
			config: parseStoredConfig(group),
			created_at: group.createdAt,
			last_run_at: startedAts.at(-1) ?? null,
			coverage: {
				conversations: new Set(groupReplays.map((r) => r.conversationHash)).size,
				replays: groupReplays.length,
				failed_replays: groupReplays.filter((r) => r.lifecycleState === "failed").length,
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
	const rows = fetchGroupRows(store, req.config_hashes);

	// Included replays are resolved before scope is applied, because the scope
	// itself is defined by what each config *completed* — a conversation only
	// one config finished isn't shared workload even if both attempted it.
	const perGroupIncluded = groups.map((group) =>
		selectIncludedReplays(narrowToGroup(rows.replays, group.hash), req.replay_selection),
	);
	const scope = conversationScopeFilter(
		perGroupIncluded.map((included) => [...new Set(included.map((r) => r.conversationHash))]),
		req.conversation_scope,
	);

	const groupResults: RunConfigGroupResult[] = groups.map((group, idx) => {
		const included = (perGroupIncluded[idx] ?? []).filter((replay) =>
			scope.included.has(replay.conversationHash),
		);
		return {
			hash: group.hash,
			name: group.name,
			config: parseStoredConfig(group),
			coverage: coverageOf(narrowToGroup(rows.replays, group.hash), included),
			metrics: buildMetrics(aggregateInputFor(rows, group.hash, included)),
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
 * conversation row carries the replay its numbers came from so the UI can link
 * straight to the inspector and the outlier can be listened to.
 *
 * Throws `RunConfigNotFoundError` on an unknown hash.
 */
export function getRunConfigDetail(
	store: Store,
	hash: string,
	selection: ReplaySelection,
): RunConfigDetailResponse {
	const group = requireGroup(store, hash);
	const rows = fetchGroupRows(store, [hash]);
	const groupReplays = narrowToGroup(rows.replays, hash);
	const included = selectIncludedReplays(groupReplays, selection);
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
	const passedById = new Map(
		narrowToGroup(rows.evaluations, hash).map((row) => [row.replayId, row.passed] as const),
	);

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
			metrics: buildMetrics(aggregateInputFor(rows, hash, conversationReplays)),
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
		metrics: buildMetrics(aggregateInputFor(rows, hash, included)),
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
