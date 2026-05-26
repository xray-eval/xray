/**
 * Thrown by the assertion evaluator when the assertion *itself* cannot be
 * dispatched — a bug in `evaluateAssertion`, not a per-assertion failure.
 * Per-assertion failures map to `AssertionOutcome.status` ("failed" /
 * "errored"), never to a thrown error.
 *
 * The evaluator currently can't throw — every variant is dispatched
 * exhaustively via ts-pattern — but this class exists so callers
 * (evaluate-replay processor) have one typed branch to catch instead of
 * a bare `Error`.
 */
export class AssertionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AssertionError";
	}
}

export class AssertionEvaluationError extends AssertionError {
	readonly assertionKind: string;
	constructor(assertionKind: string, message: string, options?: ErrorOptions) {
		super(`Failed to evaluate assertion of kind "${assertionKind}": ${message}`, options);
		this.name = "AssertionEvaluationError";
		this.assertionKind = assertionKind;
	}
}

/**
 * The spec's turn sequence can't be aligned to the VAD-derived turn sequence.
 *
 * The evaluator walks `spec.turns` in order; for each spec turn it advances a
 * cursor through `replay_turns` (sorted by `idx`) and pairs the spec turn with
 * the first VAD turn at-or-after the cursor whose role matches. The walk
 * tolerates extra VAD turns (background noise, agent self-correction, etc.) —
 * those are persisted + transcribed + OTel-attributed, just unused for
 * assertion dispatch. The walk fails when the cursor exhausts `replay_turns`
 * before every spec turn has been matched: the dev's conversation literally
 * didn't happen in the recording, so every assertion's pass/fail would be
 * arbitrary.
 *
 * Maps to `failure_reason='spec_vad_mismatch'` in the replays row.
 */
export class SpecVadMismatchError extends AssertionError {
	readonly specTurnIdx: number;
	readonly specRole: "user" | "agent";
	readonly specTurnCount: number;
	readonly vadTurnCount: number;
	constructor(
		specTurnIdx: number,
		specRole: "user" | "agent",
		specTurnCount: number,
		vadTurnCount: number,
	) {
		super(
			`No VAD turn matched spec turn ${specTurnIdx} (role="${specRole}"); spec declared ${specTurnCount} turn(s) but VAD detected ${vadTurnCount}`,
		);
		this.name = "SpecVadMismatchError";
		this.specTurnIdx = specTurnIdx;
		this.specRole = specRole;
		this.specTurnCount = specTurnCount;
		this.vadTurnCount = vadTurnCount;
	}
}
