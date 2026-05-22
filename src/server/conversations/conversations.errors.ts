import type { BaseIssue } from "valibot";

export class ConversationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ConversationError";
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

export class InvalidConversationRequestError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[];
	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid conversation request body");
		this.name = "InvalidConversationRequestError";
		this.issues = issues;
	}
}

export class MalformedConversationBodyError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[] = MALFORMED_BODY_ISSUES;
	constructor(options?: ErrorOptions) {
		super("Request body must be valid JSON", options);
		this.name = "MalformedConversationBodyError";
	}
}

const MISSING_SPEC_PART_ISSUES: readonly BaseIssue<unknown>[] = Object.freeze([
	{
		kind: "schema",
		type: "multipart_part",
		input: undefined,
		expected: "form part named `spec` carrying the conversation JSON",
		received: "absent",
		message: "Multipart body is missing the `spec` part",
	},
]);

/** Multipart `POST /v1/conversations` body had no string `spec` part. */
export class MissingSpecPartError extends MalformedConversationBodyError {
	override readonly issues: readonly BaseIssue<unknown>[] = MISSING_SPEC_PART_ISSUES;
	constructor() {
		super();
		this.name = "MissingSpecPartError";
	}
}

export class ConversationBodyTooLargeError extends ConversationError {
	readonly maxBytes: number;
	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = "ConversationBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/** Path-param conversation hash failed validation. */
export class InvalidConversationHashError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid conversation hash in path");
		this.name = "InvalidConversationHashError";
		this.issues = issues;
	}
}

/** `GET /v1/conversations/:hash` looked up a hash that doesn't exist. */
export class ConversationNotFoundError extends ConversationError {
	readonly conversationHash: string;

	constructor(conversationHash: string) {
		super(`Conversation "${conversationHash}" not found`);
		this.name = "ConversationNotFoundError";
		this.conversationHash = conversationHash;
	}
}

export type RecordedAudioUploadKeyReason = "missing" | "unreferenced";

/**
 * `POST /v1/replays` multipart body and the `spec` JSON's RecordedAudio
 * upload_keys don't line up.
 *
 * - `missing`: a turn references `upload_key` but no file part with that name.
 * - `unreferenced`: a file part is present but no turn references it.
 *
 * Both are mapped to 400 — silent drops would either lose audio (missing) or
 * ghost-upload orphans (unreferenced).
 */
export class RecordedAudioUploadKeyError extends ConversationError {
	readonly uploadKey: string;
	readonly reason: RecordedAudioUploadKeyReason;
	constructor(uploadKey: string, reason: RecordedAudioUploadKeyReason) {
		super(
			reason === "missing"
				? `RecordedAudio turn references upload_key "${uploadKey}" but no file part with that name was uploaded`
				: `Multipart file part "${uploadKey}" is not referenced by any RecordedAudio turn`,
		);
		this.name = "RecordedAudioUploadKeyError";
		this.uploadKey = uploadKey;
		this.reason = reason;
	}
}
