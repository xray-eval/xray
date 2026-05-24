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
