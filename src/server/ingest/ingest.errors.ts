import type { BaseIssue } from "valibot";

export class IngestError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		// Set explicitly per class — `new.target.name` would be mangled by minifiers.
		this.name = "IngestError";
	}
}

/**
 * Carries Valibot issues so the route handler can echo them back to the
 * caller; without that the operator has no signal about which field failed.
 */
export class InvalidEventError extends IngestError {
	readonly sessionId: string;
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(sessionId: string, issues: readonly BaseIssue<unknown>[]) {
		super(`Invalid event for session "${sessionId}"`);
		this.name = "InvalidEventError";
		this.sessionId = sessionId;
		this.issues = issues;
	}
}

// The synthetic issue MalformedBodyError carries has no per-instance state, so
// the frozen module-level array is shared across throws. Same shape as a real
// Valibot BaseIssue so the 400 response matches InvalidEventError's.
const MALFORMED_BODY_ISSUES: readonly BaseIssue<unknown>[] = Object.freeze([
	{
		kind: "schema",
		type: "json_body",
		input: undefined,
		expected: "valid JSON",
		received: "unparseable text",
		message: "Request body must be valid JSON",
	},
]);

/**
 * The request body wasn't parseable as JSON at all (so Valibot never ran).
 * Carries the same `issues` shape as `InvalidEventError` so the 400 response
 * is structurally identical for both failure modes — a consumer reading
 * `issues[].path` / `.message` doesn't need to branch on which 400 it got.
 */
export class MalformedBodyError extends IngestError {
	readonly sessionId: string;
	readonly issues: readonly BaseIssue<unknown>[] = MALFORMED_BODY_ISSUES;

	constructor(sessionId: string, options?: ErrorOptions) {
		super(`Malformed JSON body for session "${sessionId}"`, options);
		this.name = "MalformedBodyError";
		this.sessionId = sessionId;
	}
}

/**
 * Request body exceeded the byte cap enforced by the bodyLimit middleware.
 * Distinct from `MalformedBodyError` because the response status differs
 * (413, not 400) — operators tuning a client need to see the size error
 * separately from a schema error.
 */
export class BodyTooLargeError extends IngestError {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = "BodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/** A `tool_called` event references a turn idx no turn row has yet claimed. */
export class UnknownTurnError extends IngestError {
	readonly sessionId: string;
	readonly turnIdx: number;

	constructor(sessionId: string, turnIdx: number) {
		super(`No turn with idx ${turnIdx} in session "${sessionId}"`);
		this.name = "UnknownTurnError";
		this.sessionId = sessionId;
		this.turnIdx = turnIdx;
	}
}
