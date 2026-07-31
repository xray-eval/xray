import type { RunConfigSummary } from "@/client/api/api.types.ts";
import {
	COMPARE_CONFIGS_MAX,
	COMPARE_CONFIGS_MIN,
} from "@/server/run-configs/run-configs.types.ts";

import { partitionByActivity } from "./config-filter.ts";

/**
 * Re-exported from the server's schema rather than restated here. The picker
 * enforces the same bounds `POST /v1/run-configs/compare` validates, so a
 * change to the cap can't leave the UI offering a selection the route rejects
 * — which would surface as "Failed to load the comparison" rather than a
 * disabled card.
 */
export const MIN_COMPARE = COMPARE_CONFIGS_MIN;
export const MAX_COMPARE = COMPARE_CONFIGS_MAX;

/**
 * Selection comes from the URL so a comparison is shareable. With no `ids`, the
 * two most recently active configs are compared — the view is useful on first
 * open instead of showing an empty prompt. Derived at render, never mirrored
 * into state.
 *
 * A **present but empty** `ids` is not the same as an absent one: it's what
 * deselecting the last card writes, so it has to survive as an empty selection.
 * Defaulting it would re-select the cards the user just clicked off. A param
 * that names only configs this instance doesn't have (a shared link, a renamed
 * group) still falls back — there the user asked for a comparison, and showing
 * one beats an empty page.
 */
export function resolveSelection(
	raw: string | undefined,
	items: readonly RunConfigSummary[],
): string[] {
	// Groups that ran come first. The list is ordered by `last_run_at ??
	// created_at`, so a group created moments ago and never run sorts above
	// everything with data — taking the top two blind would open the page on a
	// comparison whose every metric is null. Never-run groups still pad the
	// selection when too few have run, because two columns beat one.
	const fallback = () => {
		const { active, neverRun } = partitionByActivity(items);
		return [...active, ...neverRun].slice(0, MIN_COMPARE).map((item) => item.hash);
	};
	if (raw === undefined) return fallback();
	if (raw.trim().length === 0) return [];
	const known = new Set(items.map((item) => item.hash));
	const requested = raw
		.split(",")
		.map((hash) => hash.trim())
		.filter((hash) => known.has(hash));
	const deduped = [...new Set(requested)].slice(0, MAX_COMPARE);
	return deduped.length > 0 ? deduped : fallback();
}

export function toggleSelection(selected: readonly string[], hash: string): string[] {
	if (selected.includes(hash)) return selected.filter((h) => h !== hash);
	if (selected.length >= MAX_COMPARE) return [...selected];
	return [...selected, hash];
}
