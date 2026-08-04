import { heatIntensity, heatRange, rankedMetricRows } from "./heat-scale.ts";
import { describe, expect, it } from "bun:test";

describe("rankedMetricRows", () => {
	it("drops metrics the tool refuses to call a winner on", () => {
		const keys = rankedMetricRows().map((row) => row.key);
		// Shading these by magnitude would name a winner the matrix deliberately
		// declines to name.
		expect(keys).not.toContain("interruption");
		expect(keys).not.toContain("tokens");
		expect(keys).toContain("pass");
		expect(keys).toContain("agent_response_ms");
	});

	it("leads with what the run scored, not how fast it was", () => {
		// Latency is the second question. Putting it first buries the outcome
		// under three grids nobody scrolled for.
		const keys = rankedMetricRows().map((row) => row.key);
		expect(keys.slice(0, 3)).toEqual(["judges", "assertions", "pass"]);
	});
});

describe("heatRange", () => {
	it("spans the values present, ignoring gaps", () => {
		expect(heatRange([1, null, 5, null, 3])).toEqual({ min: 1, max: 5, n: 3 });
	});

	it("is null when nothing was measured, so callers render no scale at all", () => {
		expect(heatRange([null, null])).toBeNull();
		expect(heatRange([])).toBeNull();
	});

	it("handles a single measured value", () => {
		expect(heatRange([42, null])).toEqual({ min: 42, max: 42, n: 1 });
	});

	it("counts the measured cells, so callers can tell a tie from a lone sample", () => {
		expect(heatRange([7, 7, null])?.n).toBe(2);
	});
});

describe("heatIntensity", () => {
	const range = { min: 0, max: 100, n: 4 };

	it("puts the best value at full intensity and the worst at none", () => {
		expect(heatIntensity(100, range, "higher")).toBe(1);
		expect(heatIntensity(0, range, "higher")).toBe(0);
	});

	it("inverts for metrics where lower is better", () => {
		// Latency: the fastest cell is the one that should read as strongest.
		expect(heatIntensity(0, range, "lower")).toBe(1);
		expect(heatIntensity(100, range, "lower")).toBe(0);
	});

	it("scales linearly between the two ends", () => {
		expect(heatIntensity(50, range, "higher")).toBe(0.5);
		expect(heatIntensity(25, range, "lower")).toBe(0.75);
	});

	it("returns null for an absent value, which is a gap rather than a worst case", () => {
		// Colouring a missing cell as "worst" would invent a measurement.
		expect(heatIntensity(null, range, "higher")).toBeNull();
	});

	it("puts a flat range at full intensity rather than dividing by zero", () => {
		// Every config scored the same — nothing to rank, so nothing is dimmed.
		expect(heatIntensity(7, { min: 7, max: 7, n: 3 }, "higher")).toBe(1);
		expect(heatIntensity(7, { min: 7, max: 7, n: 3 }, "lower")).toBe(1);
	});

	it("shades nothing when only one cell was measured", () => {
		// A lone sample is a flat range for the same arithmetic reason a tie is,
		// and shading it full would read as "won" — rewarding the config whose
		// agent happened to emit the metric. `bestCellIndex` already refuses to
		// mark a winner on the same data; the two must agree.
		expect(heatIntensity(500, { min: 500, max: 500, n: 1 }, "lower")).toBeNull();
		expect(heatIntensity(500, { min: 500, max: 500, n: 1 }, "higher")).toBeNull();
	});

	it("clamps values outside the range instead of overshooting", () => {
		expect(heatIntensity(150, range, "higher")).toBe(1);
		expect(heatIntensity(-50, range, "higher")).toBe(0);
	});
});
