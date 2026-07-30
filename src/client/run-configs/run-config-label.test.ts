import { runConfigLabel, runConfigPairs } from "./run-config-label.ts";
import { describe, expect, test } from "bun:test";

const HASH = "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";

describe("runConfigLabel", () => {
	test("prefers the name the dev gave the group", () => {
		expect(runConfigLabel("gemini-flash-strategy", { model: "gpt-4o" }, HASH)).toBe(
			"gemini-flash-strategy",
		);
	});

	test("falls back to a compact config summary when the group is unnamed", () => {
		expect(runConfigLabel(null, { model: "gpt-4o", temperature: 0.5 }, HASH)).toBe(
			"model=gpt-4o · temperature=0.5",
		);
	});

	test("truncates a long summary so it stays readable in a column header", () => {
		const label = runConfigLabel(
			null,
			{ a: "x".repeat(30), b: "y".repeat(30), c: "z".repeat(30) },
			HASH,
		);
		expect(label.length).toBeLessThanOrEqual(64);
		expect(label.endsWith("…")).toBe(true);
	});

	test("falls back to the hash prefix when there is no config content to show", () => {
		expect(runConfigLabel(null, {}, HASH)).toBe("abc123def456");
		expect(runConfigLabel(null, null, HASH)).toBe("abc123def456");
	});

	test("shows the hash prefix for a config that is not an object", () => {
		expect(runConfigLabel(null, "gpt-4o", HASH)).toBe("abc123def456");
	});

	test("treats an empty name as no name — a blank column header helps nobody", () => {
		expect(runConfigLabel("", { model: "gpt-4o" }, HASH)).toBe("model=gpt-4o");
	});
});

describe("runConfigPairs", () => {
	test("lists top-level config keys in a stable order", () => {
		expect(runConfigPairs({ temperature: 0.5, model: "gpt-4o" })).toEqual([
			{ key: "model", value: "gpt-4o" },
			{ key: "temperature", value: "0.5" },
		]);
	});

	test("renders nested values as JSON rather than [object Object]", () => {
		expect(runConfigPairs({ tools: ["search", "book"] })).toEqual([
			{ key: "tools", value: '["search","book"]' },
		]);
	});

	test("renders null and booleans readably", () => {
		expect(runConfigPairs({ seed: null, stream: true })).toEqual([
			{ key: "seed", value: "null" },
			{ key: "stream", value: "true" },
		]);
	});

	test("returns nothing for a config that is not an object", () => {
		expect(runConfigPairs("gpt-4o")).toEqual([]);
		expect(runConfigPairs(null)).toEqual([]);
	});
});
