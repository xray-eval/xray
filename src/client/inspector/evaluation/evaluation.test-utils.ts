import type {
	AssertionOutcomeResponse,
	JudgeOutcomeResponse,
	ReplayResult,
	TurnMetricsResponse,
} from "@/client/api/api.types.ts";

export function makeAssertionOutcome(
	overrides: Partial<AssertionOutcomeResponse> = {},
): AssertionOutcomeResponse {
	return {
		turn_idx: 0,
		assertion_idx: 0,
		kind: "contains",
		status: "passed",
		message: null,
		...overrides,
	};
}

export function makeJudgeOutcome(
	overrides: Partial<JudgeOutcomeResponse> = {},
): JudgeOutcomeResponse {
	return {
		judge_idx: 0,
		kind: "text_match",
		status: "passed",
		score: 90,
		reason: null,
		...overrides,
	};
}

export function makeTurnMetrics(overrides: Partial<TurnMetricsResponse> = {}): TurnMetricsResponse {
	return {
		turn_idx: 0,
		role: "agent",
		agent_response_ms: 250,
		interrupted: false,
		interruption_start_ms: null,
		...overrides,
	};
}

export function makeReplayResult(overrides: Partial<ReplayResult> = {}): ReplayResult {
	return {
		replay_id: "44444444-4444-4444-4444-444444444444",
		conversation_hash: "a".repeat(64),
		passed: true,
		assertions: [],
		judges: [],
		metrics: { turns: [] },
		...overrides,
	};
}
