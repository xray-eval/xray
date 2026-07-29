import type { AggregateInput, IncludableReplay } from "./run-configs.aggregate.ts";
import {
	aggregateMetric,
	buildMetrics,
	conversationScopeFilter,
	percentile,
	selectIncludedReplays,
} from "./run-configs.aggregate.ts";
import { describe, expect, test } from "bun:test";

describe("percentile", () => {
	test("returns null for an empty sample — there is no 95th percentile of nothing", () => {
		expect(percentile([], 95)).toBeNull();
	});

	test("a single sample is every percentile of itself", () => {
		expect(percentile([42], 50)).toBe(42);
		expect(percentile([42], 95)).toBe(42);
	});

	test("uses nearest-rank so every result is a real observed value", () => {
		const sorted = [10, 20, 30, 40];
		expect(percentile(sorted, 50)).toBe(20);
		expect(percentile(sorted, 95)).toBe(40);
		expect(percentile(sorted, 25)).toBe(10);
	});

	test("p100 is the maximum and p0 is the minimum", () => {
		expect(percentile([1, 2, 3], 100)).toBe(3);
		expect(percentile([1, 2, 3], 0)).toBe(1);
	});

	test("sorts defensively rather than trusting the caller's order", () => {
		expect(percentile([30, 10, 20], 50)).toBe(20);
	});
});

describe("aggregateMetric", () => {
	test("counts only non-null samples so nulls cannot drag the mean", () => {
		const agg = aggregateMetric([100, null, 200, null]);
		expect(agg.n).toBe(2);
		expect(agg.avg).toBe(150);
	});

	test("an all-null column reports nothing measured rather than zero", () => {
		expect(aggregateMetric([null, null])).toEqual({ avg: null, p50: null, p95: null, n: 0 });
	});

	test("an empty column reports nothing measured", () => {
		expect(aggregateMetric([])).toEqual({ avg: null, p50: null, p95: null, n: 0 });
	});

	test("rounds the mean to whole milliseconds — sub-ms precision is noise here", () => {
		expect(aggregateMetric([100, 101]).avg).toBe(101);
	});

	test("carries p50 and p95 alongside the mean", () => {
		const agg = aggregateMetric([10, 20, 30, 40]);
		expect(agg.p50).toBe(20);
		expect(agg.p95).toBe(40);
	});
});

function replay(over: Partial<IncludableReplay> = {}): IncludableReplay {
	return {
		id: "r1",
		conversationHash: "c1",
		lifecycleState: "completed",
		startedAt: "2026-07-01T00:00:00.000Z",
		...over,
	};
}

describe("selectIncludedReplays", () => {
	test("latest mode keeps one replay per conversation — the newest", () => {
		const included = selectIncludedReplays(
			[
				replay({ id: "old", startedAt: "2026-07-01T00:00:00.000Z" }),
				replay({ id: "new", startedAt: "2026-07-02T00:00:00.000Z" }),
			],
			"latest",
		);
		expect(included.map((r) => r.id)).toEqual(["new"]);
	});

	test("latest mode keeps one replay per conversation, not one overall", () => {
		const included = selectIncludedReplays(
			[replay({ id: "a", conversationHash: "c1" }), replay({ id: "b", conversationHash: "c2" })],
			"latest",
		);
		expect(included.map((r) => r.id).sort()).toEqual(["a", "b"]);
	});

	test("a later failed run does not displace an earlier completed one", () => {
		const included = selectIncludedReplays(
			[
				replay({ id: "good", startedAt: "2026-07-01T00:00:00.000Z" }),
				replay({ id: "broken", startedAt: "2026-07-02T00:00:00.000Z", lifecycleState: "failed" }),
			],
			"latest",
		);
		expect(included.map((r) => r.id)).toEqual(["good"]);
	});

	test("drops replays that never reached completed — nothing to measure", () => {
		expect(selectIncludedReplays([replay({ lifecycleState: "analyzing" })], "latest")).toEqual([]);
		expect(selectIncludedReplays([replay({ lifecycleState: "pending" })], "all")).toEqual([]);
	});

	test("breaks a started_at tie on id so the choice is stable across calls", () => {
		const included = selectIncludedReplays([replay({ id: "b" }), replay({ id: "a" })], "latest");
		expect(included.map((r) => r.id)).toEqual(["b"]);
	});

	test("all mode keeps every completed replay", () => {
		const included = selectIncludedReplays(
			[
				replay({ id: "a", startedAt: "2026-07-01T00:00:00.000Z" }),
				replay({ id: "b", startedAt: "2026-07-02T00:00:00.000Z" }),
			],
			"all",
		);
		expect(included.map((r) => r.id)).toEqual(["b", "a"]);
	});
});

describe("conversationScopeFilter", () => {
	test("union keeps every conversation any config ran", () => {
		const scope = conversationScopeFilter(
			[
				["c1", "c2"],
				["c2", "c3"],
			],
			"union",
		);
		expect([...scope.included].sort()).toEqual(["c1", "c2", "c3"]);
		expect(scope.unionCount).toBe(3);
		expect(scope.intersectionCount).toBe(1);
	});

	test("intersection keeps only conversations every config ran", () => {
		const scope = conversationScopeFilter(
			[
				["c1", "c2"],
				["c2", "c3"],
			],
			"intersection",
		);
		expect([...scope.included]).toEqual(["c2"]);
	});

	test("intersection of disjoint config coverage is empty, not everything", () => {
		const scope = conversationScopeFilter([["c1"], ["c2"]], "intersection");
		expect(scope.included.size).toBe(0);
		expect(scope.intersectionCount).toBe(0);
	});

	test("a config that ran nothing empties the intersection", () => {
		const scope = conversationScopeFilter([["c1", "c2"], []], "intersection");
		expect(scope.included.size).toBe(0);
	});

	test("reports both counts under either scope so the UI can show the gap", () => {
		const scope = conversationScopeFilter(
			[
				["c1", "c2"],
				["c1", "c2"],
			],
			"union",
		);
		expect(scope.unionCount).toBe(2);
		expect(scope.intersectionCount).toBe(2);
	});
});

function input(over: Partial<AggregateInput> = {}): AggregateInput {
	return {
		replays: [replay()],
		turnMetrics: [],
		modelUsage: [],
		evaluations: [],
		...over,
	};
}

describe("buildMetrics", () => {
	test("measures agent response time from agent turns", () => {
		const metrics = buildMetrics(
			input({
				turnMetrics: [
					{
						replayId: "r1",
						role: "agent",
						agentResponseMs: 400,
						interrupted: false,
						yieldMs: null,
					},
					{
						replayId: "r1",
						role: "agent",
						agentResponseMs: 600,
						interrupted: false,
						yieldMs: null,
					},
				],
			}),
		);
		expect(metrics.agent_response_ms.avg).toBe(500);
		expect(metrics.agent_response_ms.n).toBe(2);
	});

	test("counts the interruption rate over agent turns only", () => {
		const metrics = buildMetrics(
			input({
				turnMetrics: [
					{ replayId: "r1", role: "agent", agentResponseMs: null, interrupted: true, yieldMs: 200 },
					{
						replayId: "r1",
						role: "agent",
						agentResponseMs: null,
						interrupted: false,
						yieldMs: null,
					},
					{ replayId: "r1", role: "user", agentResponseMs: null, interrupted: true, yieldMs: null },
				],
			}),
		);
		expect(metrics.interruption).toEqual({ interrupted_turns: 1, agent_turns: 2 });
	});

	test("yield time only counts turns that were actually interrupted", () => {
		const metrics = buildMetrics(
			input({
				turnMetrics: [
					{ replayId: "r1", role: "agent", agentResponseMs: null, interrupted: true, yieldMs: 300 },
					{
						replayId: "r1",
						role: "agent",
						agentResponseMs: null,
						interrupted: false,
						yieldMs: null,
					},
				],
			}),
		);
		expect(metrics.yield_ms).toEqual({ avg: 300, p50: 300, p95: 300, n: 1 });
	});

	test("reads TTFT from model usage and reports its own sample size", () => {
		const metrics = buildMetrics(
			input({
				modelUsage: [
					{ replayId: "r1", ttftMs: 250, latencyMs: 900, inputTokens: 10, outputTokens: 5 },
					{ replayId: "r1", ttftMs: null, latencyMs: 1100, inputTokens: 20, outputTokens: 7 },
				],
			}),
		);
		expect(metrics.ttft_ms).toEqual({ avg: 250, p50: 250, p95: 250, n: 1 });
		expect(metrics.model_latency_ms.n).toBe(2);
		expect(metrics.model_latency_ms.avg).toBe(1000);
	});

	test("sums tokens within a replay before averaging across replays", () => {
		const metrics = buildMetrics(
			input({
				replays: [replay({ id: "r1" }), replay({ id: "r2", conversationHash: "c2" })],
				modelUsage: [
					{ replayId: "r1", ttftMs: null, latencyMs: null, inputTokens: 10, outputTokens: 5 },
					{ replayId: "r1", ttftMs: null, latencyMs: null, inputTokens: 30, outputTokens: 15 },
					{ replayId: "r2", ttftMs: null, latencyMs: null, inputTokens: 20, outputTokens: 10 },
				],
			}),
		);
		expect(metrics.tokens).toEqual({ avg_input: 30, avg_output: 15, avg_total: 45, n: 2 });
	});

	test("excludes replays with no model usage from the token sample", () => {
		const metrics = buildMetrics(
			input({
				replays: [replay({ id: "r1" }), replay({ id: "r2", conversationHash: "c2" })],
				modelUsage: [
					{ replayId: "r1", ttftMs: null, latencyMs: null, inputTokens: 10, outputTokens: 5 },
				],
			}),
		);
		expect(metrics.tokens.n).toBe(1);
		expect(metrics.tokens.avg_input).toBe(10);
	});

	test("excludes a replay whose usage rows carried no token counts", () => {
		// The GenAI vocabulary emits a model_usage row for every chat span, with
		// null tokens when the span has no `gen_ai.usage.*` attributes — common
		// for streaming completions. Such a replay measured latency, not tokens,
		// and counting it as a 0-token sample would drag the average toward zero
		// while inflating n.
		const metrics = buildMetrics(
			input({
				replays: [replay({ id: "r1" }), replay({ id: "r2", conversationHash: "c2" })],
				modelUsage: [
					{ replayId: "r1", ttftMs: 200, latencyMs: 800, inputTokens: null, outputTokens: null },
					{ replayId: "r2", ttftMs: null, latencyMs: null, inputTokens: 40, outputTokens: 20 },
				],
			}),
		);
		expect(metrics.tokens).toEqual({ avg_input: 40, avg_output: 20, avg_total: 60, n: 1 });
	});

	test("keeps a replay that reported only one side of its token split", () => {
		const metrics = buildMetrics(
			input({
				modelUsage: [
					{ replayId: "r1", ttftMs: null, latencyMs: null, inputTokens: 30, outputTokens: null },
				],
			}),
		);
		expect(metrics.tokens).toEqual({ avg_input: 30, avg_output: 0, avg_total: 30, n: 1 });
	});

	test("still measures latency and TTFT on a replay with no token counts", () => {
		const metrics = buildMetrics(
			input({
				modelUsage: [
					{ replayId: "r1", ttftMs: 200, latencyMs: 800, inputTokens: null, outputTokens: null },
				],
			}),
		);
		expect(metrics.ttft_ms.n).toBe(1);
		expect(metrics.model_latency_ms.avg).toBe(800);
		expect(metrics.tokens.n).toBe(0);
	});

	test("reports no token data rather than zero when nothing emitted usage", () => {
		expect(buildMetrics(input()).tokens).toEqual({
			avg_input: null,
			avg_output: null,
			avg_total: null,
			n: 0,
		});
	});

	test("counts the pass rate over included replays that were evaluated", () => {
		const metrics = buildMetrics(
			input({
				replays: [
					replay({ id: "r1" }),
					replay({ id: "r2", conversationHash: "c2" }),
					replay({ id: "r3", conversationHash: "c3" }),
				],
				evaluations: [
					{ replayId: "r1", passed: true },
					{ replayId: "r2", passed: false },
				],
			}),
		);
		expect(metrics.pass).toEqual({ passed: 1, total: 2 });
	});

	test("ignores rows belonging to replays outside the included set", () => {
		const metrics = buildMetrics(
			input({
				replays: [replay({ id: "r1" })],
				turnMetrics: [
					{
						replayId: "r1",
						role: "agent",
						agentResponseMs: 400,
						interrupted: false,
						yieldMs: null,
					},
					{
						replayId: "excluded",
						role: "agent",
						agentResponseMs: 9999,
						interrupted: false,
						yieldMs: null,
					},
				],
				evaluations: [
					{ replayId: "r1", passed: true },
					{ replayId: "excluded", passed: false },
				],
			}),
		);
		expect(metrics.agent_response_ms).toEqual({ avg: 400, p50: 400, p95: 400, n: 1 });
		expect(metrics.pass).toEqual({ passed: 1, total: 1 });
	});

	test("an included replay with no derived rows yields empty cells, not zeros", () => {
		const metrics = buildMetrics(input());
		expect(metrics.ttft_ms.n).toBe(0);
		expect(metrics.agent_response_ms.avg).toBeNull();
		expect(metrics.interruption).toEqual({ interrupted_turns: 0, agent_turns: 0 });
		expect(metrics.pass).toEqual({ passed: 0, total: 0 });
	});
});
