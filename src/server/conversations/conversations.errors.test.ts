import {
	ConversationBodyTooLargeError,
	ConversationError,
	ConversationNotFoundError,
	InvalidConversationIdError,
	InvalidConversationRequestError,
	MalformedConversationBodyError,
	VersionFingerprintMismatchError,
} from "./conversations.errors.ts";
import { describe, expect, it } from "bun:test";

describe("ConversationError subclasses", () => {
	it("InvalidConversationRequestError carries issues + name + parentage", () => {
		const err = new InvalidConversationRequestError([
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
		expect(err.name).toBe("InvalidConversationRequestError");
		expect(err.issues).toHaveLength(1);
	});

	it("MalformedConversationBodyError exposes a frozen issues array", () => {
		const err = new MalformedConversationBodyError();
		expect(err).toBeInstanceOf(ConversationError);
		expect(err.name).toBe("MalformedConversationBodyError");
		expect(err.issues[0]?.type).toBe("json_body");
	});

	it("InvalidConversationIdError carries issues + name", () => {
		const err = new InvalidConversationIdError([
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
		expect(err.name).toBe("InvalidConversationIdError");
	});

	it("ConversationNotFoundError carries id (+ optional version)", () => {
		const a = new ConversationNotFoundError("conv-1");
		expect(a.conversationId).toBe("conv-1");
		expect(a.conversationVersion).toBeNull();
		const b = new ConversationNotFoundError("conv-2", "v1");
		expect(b.conversationVersion).toBe("v1");
	});

	it("VersionFingerprintMismatchError carries id + version + parentage", () => {
		const err = new VersionFingerprintMismatchError("conv-1", "v1");
		expect(err).toBeInstanceOf(ConversationError);
		expect(err.name).toBe("VersionFingerprintMismatchError");
		expect(err.conversationId).toBe("conv-1");
		expect(err.conversationVersion).toBe("v1");
	});

	it("ConversationBodyTooLargeError carries maxBytes + parentage", () => {
		const err = new ConversationBodyTooLargeError(1024);
		expect(err).toBeInstanceOf(ConversationError);
		expect(err.name).toBe("ConversationBodyTooLargeError");
		expect(err.maxBytes).toBe(1024);
	});
});
