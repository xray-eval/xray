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

/**
 * Session id from the URL path failed `SessionIdSchema` (charset, length,
 * non-empty). Mirrors `InvalidQueryError` for `?cursor=…` failures — same
 * 400 shape so a client parser doesn't need to branch on which input
 * failed.
 */
export class InvalidSessionIdError extends SessionsError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid session id in path");
		this.name = "InvalidSessionIdError";
		this.issues = issues;
	}
}

/**
 * `GET /v1/sessions/:id` looked up a row that does not exist. Carries the id
 * so a route handler can echo it back in the 404 body without parsing the
 * message.
 */
export class SessionNotFoundError extends SessionsError {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session "${sessionId}" not found`);
		this.name = "SessionNotFoundError";
		this.sessionId = sessionId;
	}
}

/**
 * A stored `tool_calls.args_json` or `tool_calls.result_json` failed
 * `JSON.parse`. The columns are written exclusively via `JSON.stringify` in
 * the ingest path, so this fires only on data-integrity failures (manual DB
 * edits, a migration that mangled the column). Throwing loudly beats
 * silently emitting `null` and confusing a UI that's debugging tool calls.
 */
export class CorruptToolCallJsonError extends SessionsError {
	readonly sessionId: string;
	readonly turnId: string;
	readonly field: "args" | "result";

	constructor(sessionId: string, turnId: string, field: "args" | "result", cause: unknown) {
		super(`Session "${sessionId}" turn "${turnId}" has unparseable tool_calls.${field}_json`, {
			cause,
		});
		this.name = "CorruptToolCallJsonError";
		this.sessionId = sessionId;
		this.turnId = turnId;
		this.field = field;
	}
}
