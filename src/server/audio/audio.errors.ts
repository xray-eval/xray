import type { BaseIssue } from "valibot";

export class AudioError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		// Set explicitly per class — `new.target.name` would be mangled by minifiers.
		this.name = "AudioError";
	}
}

/** Session id failed `SessionIdSchema`, or turn idx failed `TurnIdxParamSchema`. */
export class InvalidAudioPathError extends AudioError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid session id or turn idx in audio URL");
		this.name = "InvalidAudioPathError";
		this.issues = issues;
	}
}

/** Upload arrived with a Content-Type we don't store under a known extension. */
export class UnsupportedAudioContentTypeError extends AudioError {
	readonly contentType: string | null;

	constructor(contentType: string | null) {
		super(`Unsupported audio content type: ${contentType ?? "(missing)"}`);
		this.name = "UnsupportedAudioContentTypeError";
		this.contentType = contentType;
	}
}

/** Upload body exceeded `MAX_AUDIO_BYTES`. */
export class AudioBodyTooLargeError extends AudioError {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Audio body exceeds ${maxBytes} bytes`);
		this.name = "AudioBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/** Upload referenced a (sessionId, turnIdx) pair that does not exist in the store. */
export class AudioTurnNotFoundError extends AudioError {
	readonly sessionId: string;
	readonly turnIdx: number;

	constructor(sessionId: string, turnIdx: number) {
		super(`No turn with idx ${turnIdx} in session "${sessionId}"`);
		this.name = "AudioTurnNotFoundError";
		this.sessionId = sessionId;
		this.turnIdx = turnIdx;
	}
}

/** GET request for a turn that exists but has no audio uploaded. */
export class AudioNotUploadedError extends AudioError {
	readonly sessionId: string;
	readonly turnIdx: number;

	constructor(sessionId: string, turnIdx: number) {
		super(`No audio uploaded for turn ${turnIdx} in session "${sessionId}"`);
		this.name = "AudioNotUploadedError";
		this.sessionId = sessionId;
		this.turnIdx = turnIdx;
	}
}
