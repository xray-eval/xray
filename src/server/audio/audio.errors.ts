import type { BaseIssue } from "valibot";

import type { ReplayLifecycleState } from "@/server/store/types.ts";

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
	readonly currentState: ReplayLifecycleState;
	constructor(replayId: string, currentState: ReplayLifecycleState) {
		super(`Replay "${replayId}" is in state "${currentState}" — upload not allowed`);
		this.name = "ReplayUploadStateError";
		this.replayId = replayId;
		this.currentState = currentState;
	}
}

/**
 * Stored `audio_path` has an extension that doesn't match any known
 * `AudioExtension`. Caller cannot trigger this on the upload path — the
 * extension is derived server-side from a validated `AudioContentType`. It
 * fires only on the read path when the DB row was hand-edited or written by
 * an older schema. Maps to HTTP 500 alongside `AudioPathOutsideRootError`.
 */
export class InvalidAudioExtensionError extends AudioError {
	readonly relativePath: string;
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(relativePath: string, issues: readonly BaseIssue<unknown>[]) {
		super(`Stored audio path "${relativePath}" has an unsupported extension`);
		this.name = "InvalidAudioExtensionError";
		this.relativePath = relativePath;
		this.issues = issues;
	}
}

/**
 * `buildTurn` was called with zero segments, which the caller's loop is meant
 * to prevent. Thrown only as a type-narrowing guard; never expected at
 * runtime. Maps to HTTP 500.
 */
export class AudioTurnsInvariantError extends AudioError {
	readonly reason: string;
	constructor(reason: string) {
		super(`Audio turns invariant violated: ${reason}`);
		this.name = "AudioTurnsInvariantError";
		this.reason = reason;
	}
}
