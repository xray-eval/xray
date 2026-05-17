import {
	ConversationInvalidResponseError,
	ConversationLoadError,
	InspectorError,
} from "./errors.ts";
import { describe, expect, it } from "bun:test";

describe("InspectorError", () => {
	it("ConversationLoadError instanceof InspectorError + carries status", () => {
		const e = new ConversationLoadError(404);
		expect(e).toBeInstanceOf(InspectorError);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("ConversationLoadError");
		expect(e.status).toBe(404);
	});

	it("ConversationInvalidResponseError instanceof InspectorError + carries issues", () => {
		const issues = [
			{
				kind: "schema" as const,
				type: "object",
				expected: "object",
				received: "null",
				message: "bad",
				input: undefined,
			},
		];
		const e = new ConversationInvalidResponseError(issues);
		expect(e).toBeInstanceOf(InspectorError);
		expect(e.name).toBe("ConversationInvalidResponseError");
		expect(e.issues).toBe(issues);
	});
});
