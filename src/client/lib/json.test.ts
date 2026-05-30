import { isJsonContainer, isJsonRecord, safeParseJson } from "./json.ts";
import { describe, expect, it } from "bun:test";

describe("safeParseJson", () => {
	it("parses a valid JSON object", () => {
		const result = safeParseJson('{"year":2026}');
		expect(result).toEqual({ ok: true, value: { year: 2026 } });
	});

	it("parses a valid JSON scalar", () => {
		expect(safeParseJson("42")).toEqual({ ok: true, value: 42 });
		expect(safeParseJson('"hi"')).toEqual({ ok: true, value: "hi" });
		expect(safeParseJson("null")).toEqual({ ok: true, value: null });
	});

	it("reports failure for malformed JSON instead of throwing", () => {
		expect(safeParseJson("{not json")).toEqual({ ok: false });
		expect(safeParseJson("")).toEqual({ ok: false });
	});
});

describe("isJsonContainer", () => {
	it("accepts objects and arrays", () => {
		expect(isJsonContainer({})).toBe(true);
		expect(isJsonContainer({ a: 1 })).toBe(true);
		expect(isJsonContainer([1, 2])).toBe(true);
	});

	it("rejects primitives and null", () => {
		expect(isJsonContainer(null)).toBe(false);
		expect(isJsonContainer(7)).toBe(false);
		expect(isJsonContainer("x")).toBe(false);
		expect(isJsonContainer(undefined)).toBe(false);
	});
});

describe("isJsonRecord", () => {
	it("accepts plain objects only — not arrays", () => {
		expect(isJsonRecord({})).toBe(true);
		expect(isJsonRecord({ "gen_ai.system": "openai" })).toBe(true);
	});

	it("rejects arrays, null, and primitives", () => {
		expect(isJsonRecord([1, 2])).toBe(false);
		expect(isJsonRecord(null)).toBe(false);
		expect(isJsonRecord("x")).toBe(false);
	});
});
