import { shortHash } from "@/client/format.ts";

/**
 * How a run-config group is titled in the UI. A group is identified by its
 * content hash, which is unreadable, so the label degrades in three steps:
 * the name the dev gave it, else a compact summary of the config itself, else
 * the hash prefix. There is always something to show.
 */
export function runConfigLabel(name: string | null, config: unknown, hash: string): string {
	if (name !== null && name.length > 0) return name;
	const summary = runConfigPairs(config)
		.map((pair) => `${pair.key}=${pair.value}`)
		.join(" · ");
	if (summary.length === 0) return shortHash(hash);
	return truncate(summary, MAX_SUMMARY_LEN);
}

const MAX_SUMMARY_LEN = 64;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

export interface RunConfigPair {
	readonly key: string;
	readonly value: string;
}

/**
 * Top-level config keys as displayable strings, sorted by key. Top-level only:
 * devs put the model name and the knobs they're actually varying at the top
 * level, and that's what distinguishes one strategy from another. Nested values
 * render as JSON so an object shows its shape instead of `[object Object]`.
 */
export function runConfigPairs(config: unknown): RunConfigPair[] {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return [];
	return Object.entries(config)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => ({ key, value: displayValue(value) }));
}

function displayValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? "undefined";
}
