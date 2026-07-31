import { shortHash } from "@/client/format.ts";

import type { RunConfigPair } from "./run-config-label.ts";
import { runConfigPairs } from "./run-config-label.ts";

/**
 * All a facet split needs: an identity and a config to read pairs from.
 *
 * Structural rather than `RunConfigSummary` because both wire shapes carrying a
 * config get split — `RunConfigSummary` for the picker's full list, and
 * `RunConfigGroupResult` for the columns of a comparison, whose facets are
 * computed over the selected few and so differ from the picker's.
 */
export interface ConfigIdentity {
	readonly hash: string;
	readonly config: unknown;
}

export interface ConfigFacets {
	/** Pairs every config carries identically — true of the set, not of any one row. */
	readonly shared: readonly RunConfigPair[];
	/** Per config hash, the pairs that are left once the shared ones are removed. */
	readonly distinguishing: ReadonlyMap<string, readonly RunConfigPair[]>;
}

/**
 * Splits a set of configs into what they all agree on and what tells them
 * apart.
 *
 * A picker showing `model=x · region=y · turn=z` on forty rows spends its
 * width on the two thirds that are identical, and truncation then eats the
 * third that isn't — which is how forty distinct configs end up rendering as
 * forty identical strings. Stating the agreement once, above the list, leaves
 * each row carrying only what makes it a different run.
 *
 * With a single config there is nothing to agree with, so its pairs stay whole:
 * a lone row factored down to nothing would show no label at all.
 */
export function splitConfigFacets(items: readonly ConfigIdentity[]): ConfigFacets {
	const pairsByHash = new Map<string, readonly RunConfigPair[]>(
		items.map((item) => [item.hash, runConfigPairs(item.config)]),
	);
	if (items.length < 2) {
		return { shared: [], distinguishing: pairsByHash };
	}

	const sharedKeys = collectSharedKeys(items, pairsByHash);
	const [first] = items;
	const shared =
		first === undefined
			? []
			: (pairsByHash.get(first.hash) ?? []).filter((pair) => sharedKeys.has(pair.key));

	return {
		shared,
		distinguishing: new Map(
			items.map((item) => [
				item.hash,
				(pairsByHash.get(item.hash) ?? []).filter((pair) => !sharedKeys.has(pair.key)),
			]),
		),
	};
}

/**
 * Flat text for a config, for accessible names and anywhere chips can't go.
 * Degrades the same way the chips do: the dev's name, else what distinguishes
 * it from the rest of the set, else the hash prefix.
 */
export function facetLabelText(
	name: string | null,
	pairs: readonly RunConfigPair[],
	hash: string,
): string {
	if (name !== null && name.length > 0) return name;
	if (pairs.length === 0) return shortHash(hash);
	return pairs.map((pair) => `${pair.key}=${pair.value}`).join(" · ");
}

function collectSharedKeys(
	items: readonly ConfigIdentity[],
	pairsByHash: ReadonlyMap<string, readonly RunConfigPair[]>,
): ReadonlySet<string> {
	const [first, ...rest] = items;
	if (first === undefined) return new Set();
	const candidates = new Map((pairsByHash.get(first.hash) ?? []).map((p) => [p.key, p.value]));
	for (const item of rest) {
		const pairs = new Map((pairsByHash.get(item.hash) ?? []).map((p) => [p.key, p.value]));
		for (const [key, value] of candidates) {
			if (pairs.get(key) !== value) candidates.delete(key);
		}
	}
	return new Set(candidates.keys());
}
