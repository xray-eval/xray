import type { BaseIssue } from "valibot";

export class InspectorError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "InspectorError";
	}
}

/**
 * `GET /v1/sessions/:id` returned a non-2xx status. Carries the status so the
 * UI can distinguish 404 (the session id is gone) from generic 500s, and a
 * future telemetry hook can branch without parsing the message.
 */
export class ConversationLoadError extends InspectorError {
	readonly status: number;

	constructor(status: number) {
		super(`Server returned ${status}`);
		this.name = "ConversationLoadError";
		this.status = status;
	}
}

/**
 * Server returned 200 but the body did not match `ConversationSchema`. Carries
 * the Valibot issues for future telemetry — same shape as the sessions list's
 * `SessionsInvalidResponseError` so error surfaces stay consistent.
 */
export class ConversationInvalidResponseError extends InspectorError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Server response did not match the expected schema");
		this.name = "ConversationInvalidResponseError";
		this.issues = issues;
	}
}
