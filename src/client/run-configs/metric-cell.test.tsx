import { registerHappyDom } from "../test-happy-dom.ts";
import type { MetricCell as MetricCellData } from "./metric-rows.ts";
import { afterEach, describe, expect, it } from "bun:test";

registerHappyDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { MetricCell } = await import("./metric-cell.tsx");

afterEach(() => cleanup());

function cell(over: Partial<MetricCellData> = {}): MetricCellData {
	return { value: 250, display: "250ms", detail: "p50 240ms · p95 900ms", n: 12, ...over };
}

describe("MetricCell", () => {
	it("shows the number, the distribution behind it and the sample size", () => {
		render(<MetricCell cell={cell()} />);
		expect(screen.getByText("250ms")).toBeTruthy();
		expect(screen.getByText("p50 240ms · p95 900ms")).toBeTruthy();
		expect(screen.getByText("n=12")).toBeTruthy();
	});

	it("still shows n=0 for an unmeasured cell", () => {
		// Without it an em-dash reads as "measured nothing" rather than "measured
		// nothing at all".
		render(<MetricCell cell={cell({ value: null, display: "—", detail: null, n: 0 })} />);
		expect(screen.getByText("n=0")).toBeTruthy();
	});

	it("omits the detail line when there is no distribution to show", () => {
		render(<MetricCell cell={cell({ detail: null })} />);
		expect(screen.queryByText(/p50/)).toBeNull();
	});

	it("marks the winning cell, and only when told to", () => {
		const { unmount } = render(<MetricCell cell={cell()} best />);
		expect(screen.getByText("best")).toBeTruthy();
		unmount();

		render(<MetricCell cell={cell()} />);
		expect(screen.queryByText("best")).toBeNull();
	});
});
