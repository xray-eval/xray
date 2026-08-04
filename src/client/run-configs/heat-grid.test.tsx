import { registerHappyDom } from "../test-happy-dom.ts";
// Type-only, so it is erased before happy-dom has to be registered below.
import type { RankedMetricRow } from "./heat-scale.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { withRouter } = await import("../test-utils.tsx");
const { HeatGrid } = await import("./heat-grid.tsx");
const { makeCompareResponse, makeRunConfigGroupResult, makeRunConfigMetrics } = await import(
	"./test-utils.ts"
);
const { rankedMetricRows } = await import("./heat-scale.ts");
const { splitConfigFacets } = await import("./config-facets.ts");

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

/**
 * Facets always come from the groups being compared, exactly as `CompareBody`
 * derives them — a test that hand-built them could pass on a split the app
 * never produces.
 *
 * The cells link to their replays, so the grid needs a router around it, and
 * TanStack Router mounts asynchronously. Awaiting the slot rather than the table
 * is what lets the "renders nothing" cases prove the router got there *and*
 * produced no grid — waiting on the table would hang for exactly those.
 */
async function renderGrid(data: ReturnType<typeof makeCompareResponse>, row: RankedMetricRow) {
	render(
		withRouter(
			<div data-testid="grid-slot">
				<HeatGrid comparison={data} row={row} facets={splitConfigFacets(data.groups)} />
			</div>,
		),
	);
	return await waitFor(() => screen.getByTestId("grid-slot"));
}

describe("HeatGrid", () => {
	it("puts a conversation on every row and a config on every column", async () => {
		await renderGrid(comparison(), passRow());

		expect(screen.getByRole("rowheader", { name: "alpha" })).toBeDefined();
		expect(screen.getByRole("rowheader", { name: "bravo" })).toBeDefined();
		expect(screen.getByRole("columnheader", { name: /baseline/ })).toBeDefined();
		expect(screen.getByRole("columnheader", { name: /fast-follow/ })).toBeDefined();
	});

	it("shows the measured value in each cell", async () => {
		await renderGrid(comparison(), passRow());

		const cells = screen.getAllByRole("cell");
		expect(cells.map((c) => c.textContent)).toEqual(["100%", "50%", "0%", "—"]);
	});

	it("marks a conversation a config never ran as a gap, not a zero", async () => {
		// fast-follow has no bravo cell. Rendering 0% there would claim a
		// measurement that was never taken.
		await renderGrid(comparison(), passRow());

		const gap = screen.getByRole("cell", { name: "not run" });
		expect(gap.textContent).toBe("—");
	});

	it("names the metric it is showing", async () => {
		await renderGrid(comparison(), passRow());
		expect(screen.getByRole("table").getAttribute("aria-label")).toContain("Replay pass rate");
	});

	it("heads each column with what distinguishes that config, not a shared prefix", async () => {
		// A column is 6rem wide and truncates. `runConfigLabel` joins every pair
		// alphabetically and cuts at 64 chars, so configs that share a long prefix
		// all rendered the same visible string — the exact failure the picker's
		// facet split exists to prevent, reintroduced one component over.
		const shared = "openai_gpt5_6_luna_preview_2026_07_14_high_reasoning";
		const unnamed = makeCompareResponse({
			conversations: [{ hash: ALPHA, name: "alpha" }],
			groups: [
				makeRunConfigGroupResult({
					hash: A,
					config: { ai_model: shared, temperature: "0.2" },
					conversations: [
						{
							conversation_hash: ALPHA,
							replay_id: "r-a",
							metrics: makeRunConfigMetrics({ pass: { passed: 1, total: 1 } }),
						},
					],
				}),
				makeRunConfigGroupResult({
					hash: B,
					config: { ai_model: shared, temperature: "0.9" },
					conversations: [
						{
							conversation_hash: ALPHA,
							replay_id: "r-b",
							metrics: makeRunConfigMetrics({ pass: { passed: 0, total: 1 } }),
						},
					],
				}),
			],
		});
		await renderGrid(unnamed, passRow());

		expect(screen.getByRole("columnheader", { name: "temperature=0.2" })).toBeDefined();
		expect(screen.getByRole("columnheader", { name: "temperature=0.9" })).toBeDefined();
	});

	it("keeps the full config on the column for a reader who wants all of it", async () => {
		await renderGrid(comparison(), passRow());
		const header = screen.getByRole("columnheader", { name: /baseline/ });
		expect(header.querySelector("[title]")?.getAttribute("title")).toBe("baseline");
	});

	it("renders nothing when the metric was never measured", async () => {
		// A full grid of em-dashes is noise: it occupies a screen to report that
		// nothing was recorded, which the absence of the grid says just as well.
		const unmeasured = rankedMetricRows().find((r) => r.key === "model_latency_ms");
		if (unmeasured === undefined) throw new Error("model_latency_ms row is missing");
		const slot = await renderGrid(comparison(), unmeasured);
		expect(slot.textContent).toBe("");
	});

	it("renders nothing when no conversation is in scope", async () => {
		const slot = await renderGrid(makeCompareResponse(), passRow());
		expect(slot.textContent).toBe("");
	});

	it("opens the replay behind each measured number", async () => {
		// The point of the grid is spotting a bad cell; the point of spotting one
		// is going and listening to it. The cell's own replay id is the only
		// thing that identifies which run produced that number.
		await renderGrid(comparison(), passRow());

		const cell = screen.getByRole("link", { name: /^alpha: 100%/ });
		expect(cell.getAttribute("href")).toBe("/replays/base-alpha");
		expect(screen.getByRole("link", { name: /^alpha: 50%/ }).getAttribute("href")).toBe(
			"/replays/fast-alpha",
		);
	});

	it("names the cell link by its conversation, not by the bare number", async () => {
		// A screen reader listing links would otherwise read "50%" once per cell
		// with nothing saying which run each one is.
		await renderGrid(comparison(), passRow());
		expect(screen.getByRole("link", { name: "bravo: 0% — open this replay" })).toBeDefined();
	});

	it("leaves a conversation a config never ran unlinked", async () => {
		// There is no replay to open. A link to nothing is worse than no link.
		await renderGrid(comparison(), passRow());
		const gap = screen.getByRole("cell", { name: "not run" });
		expect(gap.querySelector("a")).toBeNull();
	});

	it("shades each cell by where its number sits in the grid's range", async () => {
		// `data-intensity` is the only assertable trace of the scale: happy-dom
		// silently drops `color-mix(...)`, so the inline background never lands in
		// the DOM under test and a broken scale would look identical to a good one.
		await renderGrid(comparison(), passRow());

		const intensity = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("data-intensity");
		expect(intensity(/^alpha: 100%/)).toBe("1");
		expect(intensity(/^alpha: 50%/)).toBe("0.5");
		expect(intensity(/^bravo: 0%/)).toBe("0");
	});

	it("shades nothing when one config is the only one that measured the metric", async () => {
		// Full shading on the sole measured cell would read as a win, which is the
		// instrumentation-coverage reward `bestCellIndex` already declines to give.
		const ttft = rankedMetricRows().find((r) => r.key === "ttft_ms");
		if (ttft === undefined) throw new Error("ttft_ms row is missing");
		const measured = makeRunConfigMetrics({ ttft_ms: { avg: 500, p50: 500, p95: 500, n: 4 } });
		const lonely = makeCompareResponse({
			conversations: [{ hash: ALPHA, name: "alpha" }],
			groups: [
				makeRunConfigGroupResult({
					hash: A,
					name: "instrumented",
					conversations: [{ conversation_hash: ALPHA, replay_id: "r-a", metrics: measured }],
				}),
				makeRunConfigGroupResult({
					hash: B,
					name: "silent",
					conversations: [
						{
							conversation_hash: ALPHA,
							replay_id: "r-b",
							metrics: makeRunConfigMetrics(),
						},
					],
				}),
			],
		});
		await renderGrid(lonely, ttft);

		// The number still shows — it was measured, it just can't be ranked.
		const cell = screen.getByRole("link", { name: /^alpha: 500ms/ });
		expect(cell.getAttribute("data-intensity")).toBeNull();
	});
});
