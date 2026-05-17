import { formatAbsolute, formatDuration } from "./format.ts";
import { describe, expect, it } from "bun:test";

describe("formatAbsolute", () => {
	it("returns a non-empty locale string for a valid ISO timestamp", () => {
		const out = formatAbsolute("2026-05-16T12:00:00.000Z");
		// `toLocaleString` output varies by runtime locale/tz — assert only that
		// it returned a parseable date string, not the exact format.
		expect(out.length).toBeGreaterThan(0);
		expect(Number.isNaN(new Date(out).getTime())).toBe(false);
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
