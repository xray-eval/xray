import type { BaseIssue } from "valibot";

export class SessionsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionsError";
	}
}

/**
 * Query string failed Valibot validation (`agentId` too long, `limit` non-numeric,
 * `cursor` undecodable, etc). Carries the issues so the 400 response shape
 * matches the ingest route's — a client parsing `issues[].path` doesn't need
 * to branch on which 400 it got.
 */
export class InvalidQueryError extends SessionsError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid query parameters for /v1/sessions");
		this.name = "InvalidQueryError";
		this.issues = issues;
	}
}

/**
 * A `sessions` row violates the implicit invariant that `source='adapter'`
 * pairs with a non-null `provider`. Today's writers (ingest + future adapters)
 * can't produce this state, but errors.md §1 names this exact "message is
 * load-bearing" failure mode — so we throw loudly instead of silently
 * mapping the row to `source: "ingest"` on the wire.
 */
export class InconsistentSessionRowError extends SessionsError {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session "${sessionId}" has source='adapter' but provider is null`);
		this.name = "InconsistentSessionRowError";
		this.sessionId = sessionId;
	}
}
