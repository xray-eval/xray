import { match } from "ts-pattern";

import type { AssertionOutcomeResponse, ReplayResult } from "@/client/api/api.types.ts";

export type EvaluationStatus = "passed" | "failed" | "errored";
export type VerdictTone = "passed" | "failed" | "empty";

export interface OutcomeTally {
	passed: number;
	failed: number;
	errored: number;
	total: number;
}

/** Count outcomes by status. Works for assertions and judges alike — both carry a `status`. */
export function tallyOutcomes(outcomes: readonly { status: EvaluationStatus }[]): OutcomeTally {
	const result: OutcomeTally = { passed: 0, failed: 0, errored: 0, total: outcomes.length };
	for (const o of outcomes) {
		match(o.status)
			.with("passed", () => {
				result.passed += 1;
			})
			.with("failed", () => {
				result.failed += 1;
			})
			.with("errored", () => {
				result.errored += 1;
			})
			.exhaustive();
	}
	return result;
}

/**
 * "empty" when the conversation declared neither assertions nor judges (a live
 * replay): the server's `passed=true` carries no signal there, so the UI shows
 * it neutrally rather than as a triumphant pass. Otherwise the verdict is the
 * server's boolean.
 */
export function verdictTone(result: ReplayResult): VerdictTone {
	if (result.assertions.length === 0 && result.judges.length === 0) return "empty";
	return result.passed ? "passed" : "failed";
}

export interface AssertionTurnGroup {
	turnIdx: number;
	outcomes: AssertionOutcomeResponse[];
}

/**
 * Group assertion outcomes into contiguous runs by turn. The server orders them
 * by (turn_idx, assertion_idx), so opening a new group on each turn change
 * preserves order without a re-sort.
 */
export function groupAssertionsByTurn(
	assertions: readonly AssertionOutcomeResponse[],
): AssertionTurnGroup[] {
	const groups: AssertionTurnGroup[] = [];
	for (const a of assertions) {
		const last = groups.at(-1);
		if (last !== undefined && last.turnIdx === a.turn_idx) last.outcomes.push(a);
		else groups.push({ turnIdx: a.turn_idx, outcomes: [a] });
	}
	return groups;
}
