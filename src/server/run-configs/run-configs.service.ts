import type { Store } from "@/server/store/store.ts";
import type { RunConfigRow } from "@/server/store/types.ts";

import type { DerivedSamples, IncludableReplay } from "./run-configs.aggregate.ts";
import {
	buildMetrics,
	conversationScopeFilter,
	derivedForReplays,
	indexDerivedByReplay,
	selectIncludedReplays,
} from "./run-configs.aggregate.ts";
import type { GroupedReplayRow } from "./run-configs.queries.ts";
import {
	conversationNames,
	fetchDerivedRows,
	fetchGroupCoverage,
	fetchGroupReplays,
	listGroups,
	requireGroup,
} from "./run-configs.queries.ts";
import type {
	CompareRunConfigsRequest,
	CompareRunConfigsResponse,
	ListRunConfigsResponse,
	ReplaySelection,
	RunConfigCompareCell,
	RunConfigComparedConversation,
	RunConfigConversationRow,
	RunConfigCoverage,
	RunConfigDetailResponse,
	RunConfigGroupResult,
	RunConfigSummary,
} from "./run-configs.types.ts";

/**
 * The three read endpoints, composed from the store reads in
 * `run-configs.queries.ts` and the pure math in `run-configs.aggregate.ts`.
 * Nothing here writes — group membership is `run-configs.groups.ts`.
 */

function narrowToGroup<T extends { readonly runConfigHash: string }>(
	rows: readonly T[],
	hash: string,
): T[] {
	return rows.filter((row) => row.runConfigHash === hash);
}

/**
 * `failureConversations` restricts which failures count. `null` means "the
 * whole group".
 *
 * Failures are deliberately NOT filtered by `replay_selection`: a config that
 * fails runs outright is signal, and hiding it behind "latest completed" would
 * make a broken strategy look merely under-covered. `conversation_scope` is the
 * opposite case — the user narrowed the workload on purpose, and a failure in a
 * conversation they just excluded would put a "1 failed" badge on a column
 * whose every other number describes a shared workload that had no failures.
 */
function coverageOf(
	groupReplays: readonly GroupedReplayRow[],
	includedReplays: readonly IncludableReplay[],
	failureConversations: ReadonlySet<string> | null,
): RunConfigCoverage {
	const failures = groupReplays.filter(
		(r) =>
			r.lifecycleState === "failed" &&
			(failureConversations === null || failureConversations.has(r.conversationHash)),
	);
	return {
		conversations: new Set(includedReplays.map((r) => r.conversationHash)).size,
		replays: includedReplays.length,
		failed_replays: failures.length,
	};
}

/**
 * Coverage over the entire group, which is what `listRunConfigs` counts in SQL
 * for the picker card. The drill-down header has to agree with the card the
 * user clicked to get there — scoping it to the selection instead made the two
 * disagree in identical wording, and under `latest` reduced `replays` to a
 * restatement of `conversations`, since that selection keeps exactly one replay
 * per conversation. What the *metrics* were computed over is a different
 * number, and the client derives it from `conversations[].replays`.
 */
function groupCoverageOf(groupReplays: readonly GroupedReplayRow[]): RunConfigCoverage {
	return coverageOf(groupReplays, groupReplays, null);
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
	const groups = listGroups(store);
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
	// replays that actually feed a number. Indexed once here rather than per
	// caller: the group aggregate and every one of its per-conversation cells
	// read the same fetch, and re-walking all of it per cell is what makes a
	// wide comparison quadratic.
	const derived = indexDerivedByReplay(
		fetchDerivedRows(
			store,
			perGroupScoped.flatMap((included) => included.map((replay) => replay.id)),
		),
	);

	// Under `union` every conversation any config completed is in scope, so a
	// config's only-ever-failed conversation is absent from the set — passing it
	// here would silently drop exactly the failure `union` exists to show.
	const failureConversations = req.conversation_scope === "intersection" ? scope.included : null;

	const groupResults: RunConfigGroupResult[] = groups.map((group, idx) => {
		const included = perGroupScoped[idx] ?? [];
		return {
			hash: group.hash,
			name: group.name,
			config: parseStoredConfig(group),
			coverage: coverageOf(narrowToGroup(replayRows, group.hash), included, failureConversations),
			metrics: buildMetrics({ replays: included, ...derivedForReplays(derived, included) }),
			conversations: cellsFor(included, derived),
		};
	});

	return {
		replay_selection: req.replay_selection,
		conversation_scope: req.conversation_scope,
		union_conversations: scope.unionCount,
		intersection_conversations: scope.intersectionCount,
		conversations: comparedConversations(store, perGroupScoped),
		groups: groupResults,
	};
}

/**
 * One cell per conversation this group completed, over the replays already
 * narrowed by selection and scope. Conversations the group never completed are
 * simply absent — the grid renders that as a gap, which is a different claim
 * from a measured zero.
 */
function cellsFor(
	included: readonly IncludableReplay[],
	derived: ReadonlyMap<string, DerivedSamples>,
): RunConfigCompareCell[] {
	const byConversation = new Map<string, IncludableReplay[]>();
	for (const replay of included) {
		const existing = byConversation.get(replay.conversationHash);
		if (existing === undefined) byConversation.set(replay.conversationHash, [replay]);
		else existing.push(replay);
	}
	return [...byConversation].map(([conversationHash, replays]) => ({
		conversation_hash: conversationHash,
		replay_id: newestOf(replays).id,
		metrics: buildMetrics({ replays, ...derivedForReplays(derived, replays) }),
	}));
}

function newestOf(replays: readonly IncludableReplay[]): IncludableReplay {
	return replays.reduce((newest, replay) =>
		replay.startedAt > newest.startedAt ? replay : newest,
	);
}

/**
 * The grid's row set: every conversation any group contributed a cell for,
 * named once and sorted so row order doesn't depend on which config ran what.
 */
function comparedConversations(
	store: Store,
	perGroupScoped: readonly (readonly IncludableReplay[])[],
): RunConfigComparedConversation[] {
	const hashes = [
		...new Set(perGroupScoped.flatMap((included) => included.map((r) => r.conversationHash))),
	];
	const names = conversationNames(store, hashes);
	return hashes
		.map((hash) => ({ hash, name: names.get(hash) ?? hash.slice(0, 12) }))
		.sort((a, b) => a.name.localeCompare(b.name));
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
	const derivedRows = fetchDerivedRows(
		store,
		included.map((replay) => replay.id),
	);
	// Same reason as `compareRunConfigs`: one index feeds the group aggregate and
	// every conversation row, instead of each row re-walking the whole fetch.
	const derived = indexDerivedByReplay(derivedRows);
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
		derivedRows.evaluations.map((row) => [row.replayId, row.passed] as const),
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
			metrics: buildMetrics({
				replays: conversationReplays,
				...derivedForReplays(derived, conversationReplays),
			}),
		});
	}
	conversationRows.sort((a, b) => a.conversation_name.localeCompare(b.conversation_name));

	return {
		hash: group.hash,
		name: group.name,
		config: parseStoredConfig(group),
		created_at: group.createdAt,
		replay_selection: selection,
		coverage: groupCoverageOf(groupReplays),
		metrics: buildMetrics({ replays: included, ...derivedForReplays(derived, included) }),
		conversations: conversationRows,
	};
}
