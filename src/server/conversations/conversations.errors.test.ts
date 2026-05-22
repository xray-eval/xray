import {
	ConversationBodyTooLargeError,
	ConversationError,
	ConversationNotFoundError,
	InvalidConversationHashError,
	InvalidConversationRequestError,
	MalformedConversationBodyError,
	MissingSpecPartError,
	RecordedAudioUploadKeyError,
} from "./conversations.errors.ts";
import { describe, expect, it } from "bun:test";

describe("ConversationError subclasses", () => {
	it("InvalidConversationHashError carries issues + name", () => {
		const err = new InvalidConversationHashError([
			{
				kind: "schema",
				type: "x",
				input: undefined,
				expected: null,
				received: "undefined",
				message: "m",
			},
		]);
		expect(err).toBeInstanceOf(ConversationError);
		expect(err.name).toBe("InvalidConversationHashError");
		expect(err.issues).toHaveLength(1);
	});

	it("InvalidConversationRequestError carries issues + name", () => {
		const e = new InvalidConversationRequestError([
			{
				kind: "schema",
				type: "x",
				input: undefined,
				expected: null,
				received: "undefined",
				message: "m",
			},
		]);
		expect(e).toBeInstanceOf(ConversationError);
		expect(e.name).toBe("InvalidConversationRequestError");
		expect(e.issues).toHaveLength(1);
	});

	it("MalformedConversationBodyError exposes a frozen issues array", () => {
		const e = new MalformedConversationBodyError();
		expect(e).toBeInstanceOf(ConversationError);
		expect(e.name).toBe("MalformedConversationBodyError");
		expect(e.issues[0]?.type).toBe("json_body");
	});

	it("MissingSpecPartError extends MalformedConversationBodyError", () => {
		const e = new MissingSpecPartError();
		expect(e).toBeInstanceOf(MalformedConversationBodyError);
		expect(e).toBeInstanceOf(ConversationError);
		expect(e.name).toBe("MissingSpecPartError");
		expect(e.issues[0]?.type).toBe("multipart_part");
	});

	it("ConversationBodyTooLargeError carries maxBytes + name", () => {
		const e = new ConversationBodyTooLargeError(4096);
		expect(e).toBeInstanceOf(ConversationError);
		expect(e.name).toBe("ConversationBodyTooLargeError");
		expect(e.maxBytes).toBe(4096);
	});

	it("ConversationNotFoundError carries hash + name", () => {
		const e = new ConversationNotFoundError("a".repeat(64));
		expect(e).toBeInstanceOf(ConversationError);
		expect(e.name).toBe("ConversationNotFoundError");
		expect(e.conversationHash).toBe("a".repeat(64));
	});

	it("RecordedAudioUploadKeyError carries uploadKey + reason + name", () => {
		const missing = new RecordedAudioUploadKeyError("audio_0", "missing");
		expect(missing).toBeInstanceOf(ConversationError);
		expect(missing.name).toBe("RecordedAudioUploadKeyError");
		expect(missing.uploadKey).toBe("audio_0");
		expect(missing.reason).toBe("missing");

		const unreferenced = new RecordedAudioUploadKeyError("orphan", "unreferenced");
		expect(unreferenced.reason).toBe("unreferenced");
	});
});
