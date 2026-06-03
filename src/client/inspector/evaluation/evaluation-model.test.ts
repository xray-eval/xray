import { makeAssertionOutcome, makeReplayResult } from "./evaluation.test-utils.ts";
import { groupAssertionsByTurn, tallyOutcomes, verdictTone } from "./evaluation-model.ts";
import { describe, expect, it } from "bun:test";

describe("tallyOutcomes", () => {
	it("counts outcomes by status", () => {
		const t = tallyOutcomes([
			{ status: "passed" },
			{ status: "passed" },
			{ status: "failed" },
			{ status: "errored" },
		]);
		expect(t).toEqual({ passed: 2, failed: 1, errored: 1, total: 4 });
	});

	it("is all-zero for an empty list", () => {
		expect(tallyOutcomes([])).toEqual({ passed: 0, failed: 0, errored: 0, total: 0 });
	});
});

describe("verdictTone", () => {
	it("is 'empty' when neither assertions nor judges were declared", () => {
		expect(verdictTone(makeReplayResult({ passed: true }))).toBe("empty");
	});

	it("is 'passed' when the verdict is true and assertions exist", () => {
		const result = makeReplayResult({ passed: true, assertions: [makeAssertionOutcome()] });
		expect(verdictTone(result)).toBe("passed");
	});

	it("is 'failed' when the server verdict is false", () => {
		const result = makeReplayResult({
			passed: false,
			assertions: [makeAssertionOutcome({ status: "failed" })],
		});
		expect(verdictTone(result)).toBe("failed");
	});
});

describe("groupAssertionsByTurn", () => {
	it("groups contiguous turns while preserving server order", () => {
		const groups = groupAssertionsByTurn([
			makeAssertionOutcome({ turn_idx: 0, assertion_idx: 0 }),
			makeAssertionOutcome({ turn_idx: 0, assertion_idx: 1 }),
			makeAssertionOutcome({ turn_idx: 2, assertion_idx: 0 }),
		]);
		expect(groups.map((g) => g.turnIdx)).toEqual([0, 2]);
		expect(groups[0]?.outcomes).toHaveLength(2);
		expect(groups[1]?.outcomes).toHaveLength(1);
	});

	it("returns an empty array for no assertions", () => {
		expect(groupAssertionsByTurn([])).toEqual([]);
	});
});
