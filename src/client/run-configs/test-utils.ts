import type {
	CompareRunConfigsResponse,
	RunConfigGroupResult,
	RunConfigMetrics,
	RunConfigSummary,
} from "@/client/api/api.types.ts";

/**
 * Fixture builders for this slice's wire types. Every metric defaults to
 * "nothing measured" so a test states only the columns it is about — and adding
 * a metric to `RunConfigMetricsSchema` is one edit here rather than one per
 * test file.
 */
export function makeRunConfigMetrics(over: Partial<RunConfigMetrics> = {}): RunConfigMetrics {
	return {
		ttft_ms: { avg: null, p50: null, p95: null, n: 0 },
		agent_response_ms: { avg: null, p50: null, p95: null, n: 0 },
		model_latency_ms: { avg: null, p50: null, p95: null, n: 0 },
		yield_ms: { avg: null, p50: null, p95: null, n: 0 },
		interruption: { interrupted_turns: 0, agent_turns: 0 },
		tokens: { avg_input: null, avg_output: null, avg_total: null, n: 0 },
		pass: { passed: 0, total: 0 },
		assertions: { passed: 0, total: 0 },
		judges: { passed: 0, total: 0 },
		...over,
	};
}

export function makeRunConfigGroupResult(
	over: Partial<RunConfigGroupResult> & { hash: string },
): RunConfigGroupResult {
	return {
		name: null,
		config: { model: "gpt-4o" },
		coverage: { conversations: 1, replays: 1, failed_replays: 0 },
		metrics: makeRunConfigMetrics(),
		conversations: [],
		...over,
	};
}

export function makeCompareResponse(
	over: Partial<CompareRunConfigsResponse> = {},
): CompareRunConfigsResponse {
	return {
		replay_selection: "latest",
		conversation_scope: "union",
		union_conversations: 1,
		intersection_conversations: 1,
		conversations: [],
		groups: [],
		...over,
	};
}

export function makeRunConfigSummary(
	over: Partial<RunConfigSummary> & { hash: string },
): RunConfigSummary {
	return {
		name: null,
		config: { model: "gpt-4o" },
		created_at: "2026-07-01T00:00:00.000Z",
		last_run_at: "2026-07-01T00:00:00.000Z",
		coverage: { conversations: 1, replays: 1, failed_replays: 0 },
		...over,
	};
}
