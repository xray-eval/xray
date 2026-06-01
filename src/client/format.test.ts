import {
	formatAbsolute,
	formatClockSeconds,
	formatDuration,
	formatDurationMs,
	formatTimelineTick,
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

describe("formatClockSeconds", () => {
	it("renders a sub-minute time as `0:SS.d`", () => {
		expect(formatClockSeconds(0)).toBe("0:00.0");
		expect(formatClockSeconds(5.3)).toBe("0:05.3");
	});

	it("rolls whole minutes into the leading field", () => {
		expect(formatClockSeconds(65)).toBe("1:05.0");
		expect(formatClockSeconds(83.7)).toBe("1:23.7");
		expect(formatClockSeconds(125.4)).toBe("2:05.4");
	});

	it("clamps negative and non-finite inputs to zero", () => {
		expect(formatClockSeconds(-3)).toBe("0:00.0");
		expect(formatClockSeconds(Number.NaN)).toBe("0:00.0");
		expect(formatClockSeconds(Number.POSITIVE_INFINITY)).toBe("0:00.0");
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

describe("formatTimelineTick", () => {
	it("renders sub-10s ticks as a 2-decimal seconds value", () => {
		expect(formatTimelineTick(0)).toBe("0.00s");
		expect(formatTimelineTick(5.3)).toBe("5.30s");
		expect(formatTimelineTick(9.99)).toBe("9.99s");
	});

	it("switches to `MM:SS.d` at and above 10s", () => {
		expect(formatTimelineTick(10)).toBe("00:10.0");
		expect(formatTimelineTick(65)).toBe("01:05.0");
		expect(formatTimelineTick(83.7)).toBe("01:23.7");
		expect(formatTimelineTick(125.4)).toBe("02:05.4");
	});

	it("rounds to deciseconds before splitting so the minute boundary doesn't render `:60`", () => {
		expect(formatTimelineTick(59.96)).toBe("01:00.0");
	});

	it("keeps a leading minus on negative offsets", () => {
		expect(formatTimelineTick(-2.5)).toBe("-2.50s");
		expect(formatTimelineTick(-65)).toBe("-01:05.0");
	});

	it("renders non-finite input as an em-dash", () => {
		expect(formatTimelineTick(Number.NaN)).toBe("—");
		expect(formatTimelineTick(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

describe("formatDurationMs", () => {
	it("renders sub-second durations as rounded ms", () => {
		expect(formatDurationMs(0)).toBe("0ms");
		expect(formatDurationMs(42)).toBe("42ms");
		expect(formatDurationMs(999)).toBe("999ms");
	});

	it("renders second+ durations with 2-decimal precision", () => {
		expect(formatDurationMs(1_000)).toBe("1.00s");
		expect(formatDurationMs(1_500)).toBe("1.50s");
		expect(formatDurationMs(125_000)).toBe("125.00s");
	});

	it("renders non-finite or negative input as an em-dash", () => {
		expect(formatDurationMs(-1)).toBe("—");
		expect(formatDurationMs(Number.NaN)).toBe("—");
	});
});
