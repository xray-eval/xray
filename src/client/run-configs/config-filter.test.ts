import { filterConfigs, partitionByActivity } from "./config-filter.ts";
import { makeRunConfigSummary } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function hashesOf(items: readonly { hash: string }[]): string[] {
	return items.map((i) => i.hash);
}

describe("filterConfigs", () => {
	const items = [
		makeRunConfigSummary({ hash: HASH_A, name: "baseline", config: { model: "gpt-5" } }),
		makeRunConfigSummary({ hash: HASH_B, name: null, config: { model: "claude-opus" } }),
	];

	it("returns everything for a blank or whitespace query", () => {
		expect(hashesOf(filterConfigs(items, ""))).toEqual([HASH_A, HASH_B]);
		expect(hashesOf(filterConfigs(items, "   "))).toEqual([HASH_A, HASH_B]);
	});

	it("matches on the name a dev gave the config, case-insensitively", () => {
		expect(hashesOf(filterConfigs(items, "BASE"))).toEqual([HASH_A]);
	});

	it("matches on a config value, which is how an unnamed config is found", () => {
		expect(hashesOf(filterConfigs(items, "opus"))).toEqual([HASH_B]);
	});

	it("matches on a config key", () => {
		expect(hashesOf(filterConfigs(items, "model"))).toEqual([HASH_A, HASH_B]);
	});

	it("matches on a hash prefix, so a shared link's id is findable", () => {
		expect(hashesOf(filterConfigs(items, "aaaa"))).toEqual([HASH_A]);
	});

	it("returns nothing when the query matches nothing", () => {
		expect(filterConfigs(items, "nonexistent")).toEqual([]);
	});
});

describe("partitionByActivity", () => {
	it("separates configs no replay has ever run under", () => {
		const active = makeRunConfigSummary({
			hash: HASH_A,
			coverage: { conversations: 2, replays: 3, failed_replays: 0 },
		});
		// A group whose only replays failed has still been exercised — it has
		// something to say in a comparison, unlike one that never ran.
		const failedOnly = makeRunConfigSummary({
			hash: "c".repeat(64),
			coverage: { conversations: 1, replays: 1, failed_replays: 1 },
		});
		const neverRun = makeRunConfigSummary({
			hash: HASH_B,
			coverage: { conversations: 0, replays: 0, failed_replays: 0 },
		});

		const result = partitionByActivity([active, neverRun, failedOnly]);

		expect(hashesOf(result.active)).toEqual([HASH_A, "c".repeat(64)]);
		expect(hashesOf(result.neverRun)).toEqual([HASH_B]);
	});

	it("preserves the server's ordering within each partition", () => {
		const first = makeRunConfigSummary({ hash: HASH_A });
		const second = makeRunConfigSummary({ hash: HASH_B });
		expect(hashesOf(partitionByActivity([first, second]).active)).toEqual([HASH_A, HASH_B]);
	});
});
