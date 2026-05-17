import type { BaseIssue } from "valibot";

export class ReplayError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReplayError";
	}
}

/**
 * `POST /v1/replays` body failed Valibot validation. Same `issues` shape as
 * the ingest router's 400 so clients can parse one error format.
 */
export class InvalidReplayRequestError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid POST /v1/replays body");
		this.name = "InvalidReplayRequestError";
		this.issues = issues;
	}
}

// Carried by `MalformedBodyError` so its 400 response shape matches
// `InvalidReplayRequestError`'s — clients reading `issues[].path` don't
// need to branch on which 400 they got.
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

/** Request body wasn't parseable as JSON. Distinct from schema-validation failure. */
export class MalformedBodyError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[] = MALFORMED_BODY_ISSUES;

	constructor(options?: ErrorOptions) {
		super("Request body must be valid JSON", options);
		this.name = "MalformedBodyError";
	}
}

/** Request body exceeded the byte cap. Different HTTP status from a 400 schema error. */
export class BodyTooLargeError extends ReplayError {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = "BodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/** The path-param replay id failed `ReplayIdSchema`. */
export class InvalidReplayIdError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid replay id in path");
		this.name = "InvalidReplayIdError";
		this.issues = issues;
	}
}

/** The path-param session id failed `SessionIdSchema`. */
export class InvalidSessionIdError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid session id in path");
		this.name = "InvalidSessionIdError";
		this.issues = issues;
	}
}

/** `GET /v1/replays/:id` looked up an id that doesn't exist. */
export class ReplayRunNotFoundError extends ReplayError {
	readonly replayId: string;

	constructor(replayId: string) {
		super(`Replay run "${replayId}" not found`);
		this.name = "ReplayRunNotFoundError";
		this.replayId = replayId;
	}
}

/** Caller asked to replay a session that doesn't exist in the store. */
export class SourceSessionNotFoundError extends ReplayError {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Source session "${sessionId}" does not exist`);
		this.name = "SourceSessionNotFoundError";
		this.sessionId = sessionId;
	}
}

/**
 * Webhook returned a non-2xx status. The worker writes the status into the
 * replay run's `error` field so the UI can show it without parsing the
 * `.message`.
 */
export class WebhookHttpError extends ReplayError {
	readonly status: number;

	constructor(status: number) {
		super(`Webhook returned HTTP ${status}`);
		this.name = "WebhookHttpError";
		this.status = status;
	}
}

/** Webhook response body failed `WebhookResponseSchema`. */
export class WebhookResponseShapeError extends ReplayError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Webhook response did not match the expected schema");
		this.name = "WebhookResponseShapeError";
		this.issues = issues;
	}
}

/** Webhook response wasn't valid JSON. */
export class WebhookResponseNotJsonError extends ReplayError {
	constructor(options?: ErrorOptions) {
		super("Webhook response body was not valid JSON", options);
		this.name = "WebhookResponseNotJsonError";
	}
}

/** Network-level error reaching the webhook (DNS, refused, timeout). */
export class WebhookFetchError extends ReplayError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WebhookFetchError";
	}
}

/**
 * A source `tool_calls.{args,result}_json` value failed `JSON.parse`. Writers
 * stringify on insert, so a parse failure is data corruption — feeding `null`
 * into `recordedToolResults` would silently produce a different replay output
 * than the original.
 */
export class CorruptToolCallJsonError extends ReplayError {
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
