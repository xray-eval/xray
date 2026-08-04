import type { RunConfigSummary } from "@/client/api/api.types.ts";

import { runConfigPairs } from "./run-config-label.ts";

/**
 * Substring search across everything that identifies a config: the name, the
 * hash, and every `key=value` in the config itself. Searching the pairs rather
 * than the rendered label is what lets an unnamed config be found by the one
 * knob the dev remembers changing.
 */
export function filterConfigs(
	items: readonly RunConfigSummary[],
	query: string,
): readonly RunConfigSummary[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return items;
	return items.filter((item) => haystack(item).includes(needle));
}

function haystack(item: RunConfigSummary): string {
	const pairs = runConfigPairs(item.config).map((pair) => `${pair.key}=${pair.value}`);
	return [item.name ?? "", item.hash, ...pairs].join(" ").toLowerCase();
}

export interface ActivityPartition {
	readonly active: readonly RunConfigSummary[];
	readonly neverRun: readonly RunConfigSummary[];
}

/**
 * Splits off the groups no replay has ever run under. They can only ever
 * contribute an empty column to a comparison, so the picker shows them behind
 * a disclosure rather than interleaved with groups that have data.
 *
 * A group whose replays all failed counts as active: that it fails is the
 * finding, and burying it would hide a broken strategy behind a label that
 * says "never run".
 */
export function partitionByActivity(items: readonly RunConfigSummary[]): ActivityPartition {
	return {
		active: items.filter((item) => item.coverage.replays > 0),
		neverRun: items.filter((item) => item.coverage.replays === 0),
	};
}
