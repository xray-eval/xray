import { registerHappyDom } from "../test-happy-dom.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { HeatGrid } = await import("./heat-grid.tsx");
const { makeCompareResponse, makeRunConfigGroupResult, makeRunConfigMetrics } = await import(
	"./test-utils.ts"
);
const { rankedMetricRows } = await import("./heat-scale.ts");

afterEach(() => cleanup());

const A = "a".repeat(64);
const B = "b".repeat(64);
const ALPHA = "1".repeat(64);
const BRAVO = "2".repeat(64);

function passRow() {
	const row = rankedMetricRows().find((r) => r.key === "pass");
	if (row === undefined) throw new Error("pass metric row is missing");
	return row;
}

/** baseline scores 100%/0%, fast scores 50% on alpha and never ran bravo. */
function comparison() {
	return makeCompareResponse({
		conversations: [
			{ hash: ALPHA, name: "alpha" },
			{ hash: BRAVO, name: "bravo" },
		],
		groups: [
			makeRunConfigGroupResult({
				hash: A,
				name: "baseline",
				conversations: [
					{
						conversation_hash: ALPHA,
						replay_id: "base-alpha",
						metrics: makeRunConfigMetrics({ pass: { passed: 1, total: 1 } }),
					},
					{
						conversation_hash: BRAVO,
						replay_id: "base-bravo",
						metrics: makeRunConfigMetrics({ pass: { passed: 0, total: 1 } }),
					},
				],
			}),
			makeRunConfigGroupResult({
				hash: B,
				name: "fast-follow",
				conversations: [
					{
						conversation_hash: ALPHA,
						replay_id: "fast-alpha",
						metrics: makeRunConfigMetrics({ pass: { passed: 1, total: 2 } }),
					},
				],
			}),
		],
	});
}

describe("HeatGrid", () => {
	it("puts a conversation on every row and a config on every column", () => {
		render(<HeatGrid comparison={comparison()} row={passRow()} />);

		expect(screen.getByRole("rowheader", { name: "alpha" })).toBeDefined();
		expect(screen.getByRole("rowheader", { name: "bravo" })).toBeDefined();
		expect(screen.getByRole("columnheader", { name: /baseline/ })).toBeDefined();
		expect(screen.getByRole("columnheader", { name: /fast-follow/ })).toBeDefined();
	});

	it("shows the measured value in each cell", () => {
		render(<HeatGrid comparison={comparison()} row={passRow()} />);

		const cells = screen.getAllByRole("cell");
		expect(cells.map((c) => c.textContent)).toEqual(["100%", "50%", "0%", "—"]);
	});

	it("marks a conversation a config never ran as a gap, not a zero", () => {
		// fast-follow has no bravo cell. Rendering 0% there would claim a
		// measurement that was never taken.
		render(<HeatGrid comparison={comparison()} row={passRow()} />);

		const gap = screen.getByRole("cell", { name: "not run" });
		expect(gap.textContent).toBe("—");
	});

	it("names the metric it is showing", () => {
		render(<HeatGrid comparison={comparison()} row={passRow()} />);
		expect(screen.getByRole("table").getAttribute("aria-label")).toContain("Replay pass rate");
	});

	it("renders nothing when the metric was never measured", () => {
		// A full grid of em-dashes is noise: it occupies a screen to report that
		// nothing was recorded, which the absence of the grid says just as well.
		const unmeasured = rankedMetricRows().find((r) => r.key === "model_latency_ms");
		if (unmeasured === undefined) throw new Error("model_latency_ms row is missing");
		const { container } = render(<HeatGrid comparison={comparison()} row={unmeasured} />);
		expect(container.textContent).toBe("");
	});

	it("renders nothing when no conversation is in scope", () => {
		const { container } = render(<HeatGrid comparison={makeCompareResponse()} row={passRow()} />);
		expect(container.textContent).toBe("");
	});
});
