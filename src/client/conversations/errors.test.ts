import { ConversationsError, SessionsInvalidResponseError, SessionsLoadError } from "./errors.ts";
import { describe, expect, it } from "bun:test";

describe("SessionsLoadError", () => {
	it("is a ConversationsError + carries status", () => {
		const e = new SessionsLoadError(503);
		expect(e).toBeInstanceOf(ConversationsError);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("SessionsLoadError");
		expect(e.status).toBe(503);
	});
});

describe("SessionsInvalidResponseError", () => {
	it("is a ConversationsError + carries issues", () => {
		const issues = [
			{
				kind: "schema" as const,
				type: "object",
				expected: "object",
				received: "string",
				message: "drift",
				input: undefined,
			},
		];
		const e = new SessionsInvalidResponseError(issues);
		expect(e).toBeInstanceOf(ConversationsError);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("SessionsInvalidResponseError");
		expect(e.issues).toBe(issues);
	});
});
