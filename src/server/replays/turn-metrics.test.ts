import { projectTurnMetrics } from "./turn-metrics.ts";
import { describe, expect, it } from "bun:test";

const turns = [
	{ idx: 1, role: "agent" as const },
	{ idx: 0, role: "user" as const },
];

describe("projectTurnMetrics", () => {
	it("orders by turn idx and joins each turn to its metric row", () => {
		const out = projectTurnMetrics(turns, [
			{
				turnIdx: 1,
				agentResponseMs: 300,
				ttftMs: 90,
				interrupted: true,
				interruptionStartMs: 1200,
			},
			{
				turnIdx: 0,
				agentResponseMs: null,
				ttftMs: null,
				interrupted: false,
				interruptionStartMs: null,
			},
		]);

		expect(out.map((t) => t.turn_idx)).toEqual([0, 1]);
		expect(out[1]).toEqual({
			turn_idx: 1,
			role: "agent",
			agent_response_ms: 300,
			ttft_ms: 90,
			interrupted: true,
			interruption_start_ms: 1200,
		});
	});

	it("defaults missing metrics to nulls and interrupted=false", () => {
		const out = projectTurnMetrics([{ idx: 0, role: "agent" }], []);
		expect(out).toEqual([
			{
				turn_idx: 0,
				role: "agent",
				agent_response_ms: null,
				ttft_ms: null,
				interrupted: false,
				interruption_start_ms: null,
			},
		]);
	});
});
