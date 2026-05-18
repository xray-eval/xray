import { asInteger, asString, msBetween, pickPrefixed, safeJsonString } from "./attrs.ts";
import { describe, expect, it } from "bun:test";

describe("asString", () => {
	it("returns strings as-is", () => {
		expect(asString("hello")).toBe("hello");
		expect(asString("")).toBe("");
	});

	it("coerces numbers and booleans to their string form", () => {
		expect(asString(42)).toBe("42");
		expect(asString(3.14)).toBe("3.14");
		expect(asString(true)).toBe("true");
		expect(asString(false)).toBe("false");
	});

	it("returns null for null and undefined", () => {
		expect(asString(undefined)).toBeNull();
		expect(asString(null)).toBeNull();
	});
});

describe("asInteger", () => {
	it("truncates finite numbers toward zero", () => {
		expect(asInteger(7)).toBe(7);
		expect(asInteger(7.9)).toBe(7);
		expect(asInteger(-2.5)).toBe(-2);
		expect(asInteger(0)).toBe(0);
	});

	it("parses integer strings (including signed)", () => {
		expect(asInteger("42")).toBe(42);
		expect(asInteger("-3")).toBe(-3);
		expect(asInteger("+5")).toBe(5);
	});

	it("returns null for non-integer strings, NaN, Infinity, booleans, null, undefined", () => {
		expect(asInteger("3.14")).toBeNull();
		expect(asInteger("not a number")).toBeNull();
		expect(asInteger("")).toBeNull();
		expect(asInteger(Number.NaN)).toBeNull();
		expect(asInteger(Number.POSITIVE_INFINITY)).toBeNull();
		expect(asInteger(true)).toBeNull();
		expect(asInteger(undefined)).toBeNull();
		expect(asInteger(null)).toBeNull();
	});
});

describe("pickPrefixed", () => {
	it("returns only keys that start with the prefix", () => {
		const attrs = {
			"xray.turn.idx": 0,
			"xray.assertion.name": "n",
			"gen_ai.system": "openai",
			other: "x",
		};
		expect(pickPrefixed(attrs, "xray.")).toEqual({
			"xray.turn.idx": 0,
			"xray.assertion.name": "n",
		});
	});

	it("returns an empty object when nothing matches", () => {
		expect(pickPrefixed({ a: 1, b: 2 }, "xray.")).toEqual({});
	});

	it("does not mutate the input", () => {
		const attrs = { "xray.a": 1, "other.b": 2 };
		pickPrefixed(attrs, "xray.");
		expect(attrs).toEqual({ "xray.a": 1, "other.b": 2 });
	});
});

describe("safeJsonString", () => {
	it("round-trips a valid JSON string through parse + stringify", () => {
		expect(safeJsonString('{"a":1,"b":[2,3]}')).toBe('{"a":1,"b":[2,3]}');
	});

	it("re-stringifies parsed JSON canonically (whitespace stripped)", () => {
		expect(safeJsonString('{ "a" :  1 }')).toBe('{"a":1}');
	});

	it("falls back to JSON-quoting the raw string when input is not JSON", () => {
		expect(safeJsonString("not json")).toBe('"not json"');
		expect(safeJsonString("")).toBe('""');
	});
});

describe("msBetween", () => {
	it("returns positive integer ms between two ISO timestamps", () => {
		expect(msBetween("2026-05-18T12:00:00.000Z", "2026-05-18T12:00:01.500Z")).toBe(1500);
	});

	it("returns 0 for identical timestamps", () => {
		expect(msBetween("2026-05-18T12:00:00.000Z", "2026-05-18T12:00:00.000Z")).toBe(0);
	});

	it("returns null when end precedes start", () => {
		expect(msBetween("2026-05-18T12:00:01.000Z", "2026-05-18T12:00:00.000Z")).toBeNull();
	});

	it("returns null for unparseable timestamps", () => {
		expect(msBetween("not-a-date", "2026-05-18T12:00:00.000Z")).toBeNull();
		expect(msBetween("2026-05-18T12:00:00.000Z", "garbage")).toBeNull();
	});
});
