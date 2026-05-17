import type { BaseIssue } from "valibot";

export class ReplaysError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReplaysError";
	}
}

/**
 * `POST /v1/replays` or `GET /v1/replays/:id` returned a non-2xx. Status is
 * `readonly` so the UI can branch on 404 vs 5xx without parsing `.message`.
 */
export class ReplayLoadError extends ReplaysError {
	readonly status: number;

	constructor(status: number, message?: string) {
		super(message ?? `Server returned ${status}`);
		this.name = "ReplayLoadError";
		this.status = status;
	}
}

/** Server returned 200 but the body didn't match `ReplayRunResponseSchema`. */
export class ReplayInvalidResponseError extends ReplaysError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Server response did not match the expected schema");
		this.name = "ReplayInvalidResponseError";
		this.issues = issues;
	}
}
