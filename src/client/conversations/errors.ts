import type { BaseIssue } from "valibot";

export class ConversationsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ConversationsError";
	}
}

/**
 * The `/v1/sessions` endpoint returned a non-2xx status. Carries the status so
 * callers (telemetry, retry policy) can branch on it without parsing the
 * message.
 */
export class SessionsLoadError extends ConversationsError {
	readonly status: number;

	constructor(status: number) {
		super(`Server returned ${status}`);
		this.name = "SessionsLoadError";
		this.status = status;
	}
}

/**
 * The server returned 200 but a body that doesn't match `ListSessionsResponseSchema`.
 * Carries the Valibot issues so a future telemetry hook can surface which
 * field drifted — per boundary-validation.md §4, "the thrown error must be
 * a typed subclass" with `readonly issues: …`.
 */
export class SessionsInvalidResponseError extends ConversationsError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Server response did not match the expected schema");
		this.name = "SessionsInvalidResponseError";
		this.issues = issues;
	}
}
