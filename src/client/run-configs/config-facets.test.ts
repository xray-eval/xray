import { splitConfigFacets } from "./config-facets.ts";
import { makeRunConfigSummary } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

function pairStrings(pairs: readonly { key: string; value: string }[]): string[] {
	return pairs.map((p) => `${p.key}=${p.value}`);
}

describe("splitConfigFacets", () => {
	it("factors out a pair every config carries, so it is stated once instead of on every row", () => {
		const facets = splitConfigFacets([
			makeRunConfigSummary({ hash: "a", config: { model: "gpt-5", turn: "one" } }),
			makeRunConfigSummary({ hash: "b", config: { model: "gpt-5", turn: "two" } }),
		]);

		expect(pairStrings(facets.shared)).toEqual(["model=gpt-5"]);
		expect(pairStrings(facets.distinguishing.get("a") ?? [])).toEqual(["turn=one"]);
		expect(pairStrings(facets.distinguishing.get("b") ?? [])).toEqual(["turn=two"]);
	});

	it("keeps a key whose value differs anywhere in the set", () => {
		const facets = splitConfigFacets([
			makeRunConfigSummary({ hash: "a", config: { model: "gpt-5" } }),
			makeRunConfigSummary({ hash: "b", config: { model: "gpt-5" } }),
			makeRunConfigSummary({ hash: "c", config: { model: "claude" } }),
		]);

		expect(facets.shared).toEqual([]);
		expect(pairStrings(facets.distinguishing.get("a") ?? [])).toEqual(["model=gpt-5"]);
	});

	it("does not treat a key missing from one config as shared", () => {
		const facets = splitConfigFacets([
			makeRunConfigSummary({ hash: "a", config: { model: "gpt-5", temp: "0.2" } }),
			makeRunConfigSummary({ hash: "b", config: { model: "gpt-5" } }),
		]);

		expect(pairStrings(facets.shared)).toEqual(["model=gpt-5"]);
		expect(pairStrings(facets.distinguishing.get("a") ?? [])).toEqual(["temp=0.2"]);
		expect(facets.distinguishing.get("b")).toEqual([]);
	});

	it("shares nothing when there is one config, whose pairs are its whole identity", () => {
		const facets = splitConfigFacets([
			makeRunConfigSummary({ hash: "a", config: { model: "gpt-5", turn: "one" } }),
		]);

		expect(facets.shared).toEqual([]);
		expect(pairStrings(facets.distinguishing.get("a") ?? [])).toEqual(["model=gpt-5", "turn=one"]);
	});

	it("survives a config that is not an object", () => {
		const facets = splitConfigFacets([
			makeRunConfigSummary({ hash: "a", config: null }),
			makeRunConfigSummary({ hash: "b", config: { model: "gpt-5" } }),
		]);

		expect(facets.shared).toEqual([]);
		expect(facets.distinguishing.get("a")).toEqual([]);
		expect(pairStrings(facets.distinguishing.get("b") ?? [])).toEqual(["model=gpt-5"]);
	});

	it("has no shared pairs for an empty set", () => {
		const facets = splitConfigFacets([]);
		expect(facets.shared).toEqual([]);
		expect(facets.distinguishing.size).toBe(0);
	});
});
