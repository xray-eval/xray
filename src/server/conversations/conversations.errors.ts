import type { BaseIssue } from "valibot";

export class ConversationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ConversationError";
	}
}

/** `POST /v1/conversations` body failed Valibot validation. */
export class InvalidConversationRequestError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid POST /v1/conversations body");
		this.name = "InvalidConversationRequestError";
		this.issues = issues;
	}
}

/** A request body that wasn't valid JSON at all. */
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

export class MalformedConversationBodyError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[] = MALFORMED_BODY_ISSUES;

	constructor(options?: ErrorOptions) {
		super("Request body must be valid JSON", options);
		this.name = "MalformedConversationBodyError";
	}
}

/** Path-param conversation id failed validation. */
export class InvalidConversationIdError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid conversation id in path");
		this.name = "InvalidConversationIdError";
		this.issues = issues;
	}
}

/** `GET /v1/conversations/:id` looked up an id that doesn't exist. */
export class ConversationNotFoundError extends ConversationError {
	readonly conversationId: string;
	readonly conversationVersion: string | null;

	constructor(conversationId: string, conversationVersion: string | null = null) {
		super(
			conversationVersion === null
				? `Conversation "${conversationId}" not found`
				: `Conversation "${conversationId}" version "${conversationVersion}" not found`,
		);
		this.name = "ConversationNotFoundError";
		this.conversationId = conversationId;
		this.conversationVersion = conversationVersion;
	}
}

/**
 * Caller POSTed a Conversation whose `(id, version)` already exists with a
 * different turn fingerprint. The SDK auto-computes `version` from the turn
 * structure, so this means the dev forgot to bump `id` after editing a spec
 * that already shipped. Reject hard — silently overwriting would break
 * cross-replay alignment guarantees the UI promises.
 */
export class VersionFingerprintMismatchError extends ConversationError {
	readonly conversationId: string;
	readonly conversationVersion: string;

	constructor(conversationId: string, conversationVersion: string) {
		super(
			`Conversation "${conversationId}" version "${conversationVersion}" already exists with a different turn structure`,
		);
		this.name = "VersionFingerprintMismatchError";
		this.conversationId = conversationId;
		this.conversationVersion = conversationVersion;
	}
}

/** Request body exceeded the byte cap. */
export class ConversationBodyTooLargeError extends ConversationError {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = "ConversationBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}
