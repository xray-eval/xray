import type { RunConfigSummary } from "@/client/api/api.types.ts";

import { resolveSelection, toggleSelection } from "./compare-selection.ts";
import { describe, expect, it } from "bun:test";

const BASELINE = "a".repeat(64);
const FAST = "b".repeat(64);

const GROUPS = [
	{
		hash: FAST,
		name: "fast-follow",
		config: { model: "gemini-2.5-flash" },
		created_at: "2026-07-02T00:00:00.000Z",
		last_run_at: "2026-07-02T00:00:00.000Z",
		coverage: { conversations: 1, replays: 1, failed_replays: 0 },
	},
	{
		hash: BASELINE,
		name: "baseline",
		config: { model: "gpt-4o" },
		created_at: "2026-07-01T00:00:00.000Z",
		last_run_at: "2026-07-01T00:00:00.000Z",
		coverage: { conversations: 2, replays: 3, failed_replays: 1 },
	},
] satisfies RunConfigSummary[];

describe("resolveSelection", () => {
	it("defaults to the two most recently active configs", () => {
		expect(resolveSelection(undefined, GROUPS)).toEqual([FAST, BASELINE]);
	});

	it("keeps the order the URL asked for", () => {
		expect(resolveSelection(`${BASELINE},${FAST}`, GROUPS)).toEqual([BASELINE, FAST]);
	});

	it("drops hashes that no longer exist rather than requesting a 404", () => {
		expect(resolveSelection(`${BASELINE},${"f".repeat(64)}`, GROUPS)).toEqual([BASELINE]);
	});

	it("de-duplicates a repeated hash", () => {
		expect(resolveSelection(`${BASELINE},${BASELINE}`, GROUPS)).toEqual([BASELINE]);
	});

	it("falls back to the default when every requested hash is unknown", () => {
		expect(resolveSelection("nonsense", GROUPS)).toEqual([FAST, BASELINE]);
	});

	it("respects an empty ids param as a deliberate selection of nothing", () => {
		// Distinct from `undefined`: the user clicked the last card off. Falling
		// back here would re-select the cards they just deselected.
		expect(resolveSelection("", GROUPS)).toEqual([]);
	});
});

describe("toggleSelection", () => {
	it("adds a hash that is not selected yet", () => {
		expect(toggleSelection([BASELINE], FAST)).toEqual([BASELINE, FAST]);
	});

	it("removes a hash that is already selected", () => {
		expect(toggleSelection([BASELINE, FAST], BASELINE)).toEqual([FAST]);
	});

	it("refuses to add past the comparison cap", () => {
		const full = Array.from({ length: 8 }, (_, i) => String(i).repeat(64).slice(0, 64));
		expect(toggleSelection(full, FAST)).toEqual(full);
	});

	it("still deselects at the cap, so the picker never locks up", () => {
		const full = Array.from({ length: 8 }, (_, i) => String(i).repeat(64).slice(0, 64));
		const first = full[0];
		if (first === undefined) throw new Error("fixture is empty");
		expect(toggleSelection(full, first)).toHaveLength(7);
	});
});
