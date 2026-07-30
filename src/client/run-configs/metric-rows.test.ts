import { bestCellIndex, METRIC_ROWS } from "./metric-rows.ts";
import { makeRunConfigMetrics } from "./test-utils.ts";
import { describe, expect, test } from "bun:test";

function rowByKey(key: string) {
	const row = METRIC_ROWS.find((r) => r.key === key);
	if (row === undefined) throw new Error(`no metric row ${key}`);
	return row;
}

describe("METRIC_ROWS", () => {
	test("puts TTFT first — it's the metric the issue was opened about", () => {
		expect(METRIC_ROWS[0]?.key).toBe("ttft_ms");
	});

	test("reads a latency cell with its percentiles and sample size", () => {
		const cell = rowByKey("ttft_ms").read(
			makeRunConfigMetrics({ ttft_ms: { avg: 250, p50: 240, p95: 900, n: 12 } }),
		);
		expect(cell.value).toBe(250);
		expect(cell.display).toBe("250ms");
		expect(cell.detail).toBe("p50 240ms · p95 900ms");
		expect(cell.n).toBe(12);
	});

	test("an unmeasured cell says so instead of showing a zero", () => {
		const cell = rowByKey("ttft_ms").read(makeRunConfigMetrics());
		expect(cell.value).toBeNull();
		expect(cell.display).toBe("—");
		expect(cell.n).toBe(0);
	});

	test("interruption rate is a percentage of agent turns", () => {
		const cell = rowByKey("interruption").read(
			makeRunConfigMetrics({ interruption: { interrupted_turns: 3, agent_turns: 12 } }),
		);
		expect(cell.display).toBe("25%");
		expect(cell.detail).toBe("3 of 12 agent turns");
		expect(cell.n).toBe(12);
	});

	test("pass rate is a percentage of evaluated replays", () => {
		const cell = rowByKey("pass").read(makeRunConfigMetrics({ pass: { passed: 3, total: 4 } }));
		expect(cell.display).toBe("75%");
		expect(cell.detail).toBe("3 of 4 replays");
	});

	test("token cell shows the split behind the total", () => {
		const cell = rowByKey("tokens").read(
			makeRunConfigMetrics({ tokens: { avg_input: 120, avg_output: 40, avg_total: 160, n: 5 } }),
		);
		expect(cell.display).toBe("160");
		expect(cell.detail).toBe("120 in · 40 out");
		expect(cell.n).toBe(5);
	});

	test("token cell omits the split when the agent only reported a total", () => {
		// Langfuse can report `usage_details.total` with no breakdown. Rendering
		// that as "0 in · 0 out" under a 1500-token headline invents a measurement
		// nobody took.
		const cell = rowByKey("tokens").read(
			makeRunConfigMetrics({
				tokens: { avg_input: null, avg_output: null, avg_total: 1500, n: 2 },
			}),
		);
		expect(cell.display).toBe("1500");
		expect(cell.detail).toBeNull();
		expect(cell.n).toBe(2);
	});

	test("formats a latency above a second in seconds", () => {
		const cell = rowByKey("model_latency_ms").read(
			makeRunConfigMetrics({ model_latency_ms: { avg: 1500, p50: 1500, p95: 1500, n: 2 } }),
		);
		expect(cell.display).toBe("1.50s");
	});

	test("latency rows rank lower as better, pass rate ranks higher as better", () => {
		expect(rowByKey("ttft_ms").better).toBe("lower");
		expect(rowByKey("agent_response_ms").better).toBe("lower");
		expect(rowByKey("pass").better).toBe("higher");
	});

	test("does not rank interruption rate or token usage — neither direction is a win", () => {
		expect(rowByKey("interruption").better).toBe("none");
		expect(rowByKey("tokens").better).toBe("none");
	});
});

describe("bestCellIndex", () => {
	test("picks the lowest value when lower is better", () => {
		expect(bestCellIndex([300, 150, 400], "lower")).toBe(1);
	});

	test("picks the highest value when higher is better", () => {
		expect(bestCellIndex([0.5, 0.9, 0.7], "higher")).toBe(1);
	});

	test("ranks nothing when the metric has no better direction", () => {
		expect(bestCellIndex([300, 150], "none")).toBeNull();
	});

	test("skips unmeasured cells rather than letting a null win as the lowest", () => {
		expect(bestCellIndex([null, 500, 300], "lower")).toBe(2);
	});

	test("ranks nothing when no config measured the metric", () => {
		expect(bestCellIndex([null, null], "lower")).toBeNull();
	});

	test("ranks nothing when only one config measured it — that is not a comparison", () => {
		expect(bestCellIndex([250, null], "lower")).toBeNull();
	});

	test("ranks nothing on an exact tie — declaring a winner would be arbitrary", () => {
		expect(bestCellIndex([250, 250], "lower")).toBeNull();
	});
});
