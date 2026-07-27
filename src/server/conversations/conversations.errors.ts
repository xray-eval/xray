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

export class InvalidConversationHashError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid conversation hash in path");
		this.name = "InvalidConversationHashError";
		this.issues = issues;
	}
}

export class InvalidTurnIndexError extends ConversationError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid turn index in path");
		this.name = "InvalidTurnIndexError";
		this.issues = issues;
	}
}

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
 * A RecordedAudio turn's `upload_key` and the multipart file parts don't line
 * up. Both `missing` and `unreferenced` map to 400 — silent drops would either
 * lose audio or ghost-upload orphans.
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

export class TtsTurnMissingTextError extends ConversationError {
	readonly turnIdx: number;
	constructor(turnIdx: number) {
		super(`Turn ${turnIdx} requests TTS synthesis but carries no text`);
		this.name = "TtsTurnMissingTextError";
		this.turnIdx = turnIdx;
	}
}

/** Agent audio is observed at runtime, never synthesized — a tts audio ref on
 *  an agent turn is a spec authoring bug. */
export class TtsTurnRoleError extends ConversationError {
	readonly turnIdx: number;
	constructor(turnIdx: number) {
		super(`Turn ${turnIdx} is an agent turn — TTS audio refs are only valid on user turns`);
		this.name = "TtsTurnRoleError";
		this.turnIdx = turnIdx;
	}
}

export class TurnAudioNotFoundError extends ConversationError {
	readonly conversationHash: string;
	readonly turnIdx: number;
	constructor(conversationHash: string, turnIdx: number) {
		super(`Conversation "${conversationHash}" turn ${turnIdx} has no audio`);
		this.name = "TurnAudioNotFoundError";
		this.conversationHash = conversationHash;
		this.turnIdx = turnIdx;
	}
}
