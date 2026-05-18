import type { BaseIssue } from "valibot";

export class AudioError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AudioError";
	}
}

/** Replay id, turn idx, or content-type failed validation at the boundary. */
export class InvalidAudioPathError extends AudioError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid replay id or turn idx in audio URL");
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

/** Upload referenced a (replayId, turnIdx) that does not exist in the store. */
export class AudioTurnNotFoundError extends AudioError {
	readonly replayId: string;
	readonly turnIdx: number;

	constructor(replayId: string, turnIdx: number) {
		super(`No turn with idx ${turnIdx} in replay "${replayId}"`);
		this.name = "AudioTurnNotFoundError";
		this.replayId = replayId;
		this.turnIdx = turnIdx;
	}
}

/** GET request landed on a turn/replay with no audio uploaded. */
export class AudioNotUploadedError extends AudioError {
	readonly replayId: string;
	readonly turnIdx: number | null;

	constructor(replayId: string, turnIdx: number | null = null) {
		super(
			turnIdx === null
				? `No full-replay audio uploaded for replay "${replayId}"`
				: `No audio uploaded for turn ${turnIdx} in replay "${replayId}"`,
		);
		this.name = "AudioNotUploadedError";
		this.replayId = replayId;
		this.turnIdx = turnIdx;
	}
}

/**
 * Resolved on-disk path landed outside the configured `XRAY_AUDIO_ROOT`.
 * The store mints paths server-side, so this fires only on tampered DB
 * rows or a misconfigured root — surface it loudly rather than serve
 * arbitrary filesystem content.
 */
export class AudioPathOutsideRootError extends AudioError {
	readonly attemptedPath: string;
	readonly audioRoot: string;

	constructor(attemptedPath: string, audioRoot: string) {
		super(`Resolved audio path "${attemptedPath}" escapes audio root "${audioRoot}"`);
		this.name = "AudioPathOutsideRootError";
		this.attemptedPath = attemptedPath;
		this.audioRoot = audioRoot;
	}
}

/** Replay id failed lookup at upload time. */
export class AudioReplayNotFoundError extends AudioError {
	readonly replayId: string;
	constructor(replayId: string) {
		super(`Replay "${replayId}" not found`);
		this.name = "AudioReplayNotFoundError";
		this.replayId = replayId;
	}
}
