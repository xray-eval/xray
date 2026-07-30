import { chunkIds } from "./run-configs.queries.ts";
import { describe, expect, test } from "bun:test";

describe("chunkIds", () => {
	test("splits an id list into batches no larger than the cap", () => {
		expect(chunkIds(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
	});

	test("returns a single batch when the list fits", () => {
		expect(chunkIds(["a", "b"], 5)).toEqual([["a", "b"]]);
	});

	test("returns no batches for an empty list", () => {
		expect(chunkIds([], 5)).toEqual([]);
	});

	test("de-duplicates, so no replay's rows can be fetched by two batches", () => {
		expect(chunkIds(["a", "b", "a"], 2)).toEqual([["a", "b"]]);
	});
});
