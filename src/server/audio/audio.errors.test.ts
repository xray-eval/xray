import {
	AudioBodyTooLargeError,
	AudioError,
	AudioNotUploadedError,
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
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("UnsupportedAudioContentTypeError");
		expect(e.contentType).toBe("application/json");
	});

	it("AudioBodyTooLargeError carries the size cap", () => {
		const e = new AudioBodyTooLargeError(1234);
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("AudioBodyTooLargeError");
		expect(e.maxBytes).toBe(1234);
	});

	it("AudioTurnNotFoundError carries sessionId + turnIdx", () => {
		const e = new AudioTurnNotFoundError("sess-A", 3);
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("AudioTurnNotFoundError");
		expect(e.sessionId).toBe("sess-A");
		expect(e.turnIdx).toBe(3);
	});

	it("AudioNotUploadedError carries sessionId + turnIdx", () => {
		const e = new AudioNotUploadedError("sess-A", 5);
		expect(e).toBeInstanceOf(AudioError);
		expect(e.name).toBe("AudioNotUploadedError");
		expect(e.sessionId).toBe("sess-A");
		expect(e.turnIdx).toBe(5);
	});
});
