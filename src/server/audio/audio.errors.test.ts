import {
	AudioBodyTooLargeError,
	AudioError,
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	AudioTurnsInvariantError,
	InvalidAudioExtensionError,
	InvalidAudioPathError,
	UnsupportedAudioContentTypeError,
} from "./audio.errors.ts";
import { describe, expect, it } from "bun:test";

describe("audio errors", () => {
	it("InvalidAudioPathError is an AudioError with issues", () => {
		const issues = [
			{
				kind: "schema",
				type: "regex",
				input: "x",
				expected: "[0-9]+",
				received: "x",
				message: "m",
			},
		] as const;
		const e = new InvalidAudioPathError(issues);
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("InvalidAudioPathError");
		expect(e.issues).toBe(issues);
	});

	it("UnsupportedAudioContentTypeError keeps the offending content type", () => {
		const e = new UnsupportedAudioContentTypeError("application/json");
		expect(e.name).toBe("UnsupportedAudioContentTypeError");
		expect(e.contentType).toBe("application/json");
	});

	it("AudioBodyTooLargeError carries the size cap", () => {
		const e = new AudioBodyTooLargeError(1234);
		expect(e.maxBytes).toBe(1234);
	});

	it("AudioNotUploadedError carries replayId", () => {
		const a = new AudioNotUploadedError("r");
		expect(a.replayId).toBe("r");
	});

	it("AudioPathOutsideRootError carries the attempted path + root", () => {
		const e = new AudioPathOutsideRootError("/etc/passwd", "/data/audio");
		expect(e.attemptedPath).toBe("/etc/passwd");
		expect(e.audioRoot).toBe("/data/audio");
	});

	it("AudioReplayNotFoundError carries replayId", () => {
		const e = new AudioReplayNotFoundError("r");
		expect(e.replayId).toBe("r");
	});

	it("InvalidAudioExtensionError is an AudioError with relativePath + issues", () => {
		const issues = [
			{
				kind: "schema",
				type: "picklist",
				input: "xyz",
				expected: '"opus" | "ogg" | "webm" | "mp3" | "wav"',
				received: '"xyz"',
				message: "m",
			},
		] as const;
		const e = new InvalidAudioExtensionError("r-123/replay.xyz", issues);
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("InvalidAudioExtensionError");
		expect(e.relativePath).toBe("r-123/replay.xyz");
		expect(e.issues).toBe(issues);
	});

	it("AudioTurnsInvariantError is an AudioError with reason", () => {
		const e = new AudioTurnsInvariantError("buildTurn called with empty segments");
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("AudioTurnsInvariantError");
		expect(e.reason).toBe("buildTurn called with empty segments");
	});
});
