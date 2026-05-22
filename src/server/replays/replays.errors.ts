import type { BaseIssue } from "valibot";

import type { ReplayLifecycleState } from "@/server/store/types.ts";

export class ReplayError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReplayError";
	}
}

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

export class InvalidReplayRequestError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[];
	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid replay request body");
		this.name = "InvalidReplayRequestError";
		this.issues = issues;
	}
}

export class MalformedReplayBodyError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[] = MALFORMED_BODY_ISSUES;
	constructor(options?: ErrorOptions) {
		super("Request body must be valid JSON", options);
		this.name = "MalformedReplayBodyError";
	}
}

export class InvalidReplayIdError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[];
	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid replay id in path");
		this.name = "InvalidReplayIdError";
		this.issues = issues;
	}
}

export class ReplayNotFoundError extends ReplayError {
	readonly replayId: string;
	constructor(replayId: string) {
		super(`Replay "${replayId}" not found`);
		this.name = "ReplayNotFoundError";
		this.replayId = replayId;
	}
}

/**
 * A PATCH attempted an illegal lifecycle transition. Terminal states
 * (`completed`, `failed`) are write-once; `analyzing` is owned by the
 * worker. Mapped to 409.
 */
export class ReplayLifecycleTransitionError extends ReplayError {
	readonly replayId: string;
	readonly from: string;
	readonly to: string;
	constructor(replayId: string, from: string, to: string) {
		super(`Replay "${replayId}" cannot transition from "${from}" to "${to}"`);
		this.name = "ReplayLifecycleTransitionError";
		this.replayId = replayId;
		this.from = from;
		this.to = to;
	}
}

export class ReplayBodyTooLargeError extends ReplayError {
	readonly maxBytes: number;
	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = "ReplayBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/**
 * Caller invoked POST /analyze on a replay whose lifecycle_state is not
 * `recording_uploaded`. The driver must POST the audio first.
 */
export class ReplayNotReadyForAnalysisError extends ReplayError {
	readonly replayId: string;
	readonly currentState: ReplayLifecycleState;
	constructor(replayId: string, currentState: ReplayLifecycleState) {
		super(`Replay "${replayId}" is in state "${currentState}", not "recording_uploaded"`);
		this.name = "ReplayNotReadyForAnalysisError";
		this.replayId = replayId;
		this.currentState = currentState;
	}
}

export class InvalidCompareSelectionError extends ReplayError {
	readonly count: number;
	readonly min: number;
	readonly max: number;
	constructor(count: number, min: number, max: number) {
		super(`compare requires between ${min} and ${max} replay ids (got ${count})`);
		this.name = "InvalidCompareSelectionError";
		this.count = count;
		this.min = min;
		this.max = max;
	}
}
