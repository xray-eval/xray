import type { BaseIssue } from "valibot";

export class AudioError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AudioError";
	}
}

export class InvalidAudioPathError extends AudioError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid replay id in audio URL");
		this.name = "InvalidAudioPathError";
		this.issues = issues;
	}
}

export class UnsupportedAudioContentTypeError extends AudioError {
	readonly contentType: string | null;

	constructor(contentType: string | null) {
		super(`Unsupported audio content type: ${contentType ?? "(missing)"}`);
		this.name = "UnsupportedAudioContentTypeError";
		this.contentType = contentType;
	}
}

export class AudioBodyTooLargeError extends AudioError {
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		super(`Audio body exceeds ${maxBytes} bytes`);
		this.name = "AudioBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

export class AudioNotUploadedError extends AudioError {
	readonly replayId: string;

	constructor(replayId: string) {
		super(`No audio uploaded for replay "${replayId}"`);
		this.name = "AudioNotUploadedError";
		this.replayId = replayId;
	}
}

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

export class AudioReplayNotFoundError extends AudioError {
	readonly replayId: string;
	constructor(replayId: string) {
		super(`Replay "${replayId}" not found`);
		this.name = "AudioReplayNotFoundError";
		this.replayId = replayId;
	}
}

/** Uploaded WAV failed format validation. */
export class InvalidWavFormatError extends AudioError {
	readonly reason: string;
	constructor(reason: string) {
		super(`Invalid WAV: ${reason}`);
		this.name = "InvalidWavFormatError";
		this.reason = reason;
	}
}

/**
 * Caller tried to upload audio for a replay whose `lifecycle_state` doesn't
 * allow it. Allowed states: `pending`, `running`, `recording_uploaded`. The
 * forbidden states are:
 *   - `analyzing` — a worker is mid-run; a fresh WAV would race the VAD pass
 *     and the worker's transaction.
 *   - `completed` / `failed` — terminal; we don't unwind, and a re-upload
 *     would leave stale `replay_turns` + `speech_segments` (the previous
 *     analysis's output) dangling until somebody invoked /analyze again.
 *
 * Maps to HTTP 409. Mirrors the PATCH-side `ReplayLifecycleTransitionError`
 * guard so both write paths are consistent.
 */
export class ReplayUploadStateError extends AudioError {
	readonly replayId: string;
	readonly currentState: string;
	constructor(replayId: string, currentState: string) {
		super(`Replay "${replayId}" is in state "${currentState}" — upload not allowed`);
		this.name = "ReplayUploadStateError";
		this.replayId = replayId;
		this.currentState = currentState;
	}
}
