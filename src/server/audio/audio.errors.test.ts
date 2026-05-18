import {
	AudioBodyTooLargeError,
	AudioError,
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	AudioTurnNotFoundError,
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

	it("AudioTurnNotFoundError carries replayId + turnIdx", () => {
		const e = new AudioTurnNotFoundError("r", 3);
		expect(e.replayId).toBe("r");
		expect(e.turnIdx).toBe(3);
	});

	it("AudioNotUploadedError accepts an optional turnIdx", () => {
		const a = new AudioNotUploadedError("r");
		expect(a.turnIdx).toBeNull();
		const b = new AudioNotUploadedError("r", 4);
		expect(b.turnIdx).toBe(4);
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
});
