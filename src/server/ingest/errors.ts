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
