import {
	formatAbsolute,
	formatDuration,
	formatTimestamp,
	HASH_PREFIX_LEN,
	shortHash,
} from "./format.ts";
import { describe, expect, it } from "bun:test";

describe("shortHash", () => {
	it("returns the first HASH_PREFIX_LEN chars of a 64-char hex", () => {
		const hash = "a".repeat(40) + "b".repeat(24);
		expect(shortHash(hash)).toBe("a".repeat(HASH_PREFIX_LEN));
		expect(shortHash(hash)).toHaveLength(HASH_PREFIX_LEN);
	});

	it("returns the whole string when shorter than HASH_PREFIX_LEN", () => {
		expect(shortHash("abc")).toBe("abc");
	});

	it("returns empty string for empty input", () => {
		expect(shortHash("")).toBe("");
	});
});

describe("formatAbsolute", () => {
	it("returns a non-empty locale string for a valid ISO timestamp", () => {
		const out = formatAbsolute("2026-05-16T12:00:00.000Z");
		// `toLocaleString` output varies by runtime locale/tz — assert only that
		// it returned a parseable date string, not the exact format.
		expect(out.length).toBeGreaterThan(0);
		expect(Number.isNaN(new Date(out).getTime())).toBe(false);
	});
});

describe("formatTimestamp", () => {
	it("renders a non-empty, year-less, second-precise timestamp", () => {
		const out = formatTimestamp("2026-05-16T12:00:42.000Z");
		// Locale and tz vary by runtime; assert the shape, not the exact text.
		expect(out.length).toBeGreaterThan(0);
		// Year omitted by design. `formatAbsolute` is the year-bearing variant.
		expect(out).not.toContain("2026");
		// Second-precision: the `42` from the input should survive into the
		// output. Locales like ar-EG / fa-IR render `٤٢` / `۴۲` instead of ASCII
		// digits, so format `42` the same way the timestamp formatter would.
		const localized42 = new Intl.NumberFormat(undefined, {
			minimumIntegerDigits: 2,
			useGrouping: false,
		}).format(42);
		expect(out).toContain(localized42);
	});
});

describe("formatDuration", () => {
	it("renders null as 'in progress'", () => {
		expect(formatDuration(null)).toBe("in progress");
	});

	it("renders sub-second durations in ms", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(42)).toBe("42ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("renders sub-minute durations in whole seconds", () => {
		expect(formatDuration(1000)).toBe("1s");
		expect(formatDuration(42_499)).toBe("42s");
		expect(formatDuration(59_499)).toBe("59s");
	});

	it("renders minute+ durations as `<m>m<ss>s`", () => {
		expect(formatDuration(60_000)).toBe("1m00s");
		expect(formatDuration(125_000)).toBe("2m05s");
		// 5 min + 9 sec — confirm seconds zero-pad to two digits.
		expect(formatDuration(309_000)).toBe("5m09s");
	});
});
