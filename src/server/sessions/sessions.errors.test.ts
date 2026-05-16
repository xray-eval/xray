import {
	InconsistentSessionRowError,
	InvalidQueryError,
	SessionsError,
} from "./sessions.errors.ts";
import { describe, expect, it } from "bun:test";

describe("SessionsError", () => {
	it("InvalidQueryError instanceof SessionsError + carries issues", () => {
		const issues = [
			{
				kind: "schema" as const,
				type: "string",
				expected: "string",
				received: "number",
				message: "bad",
				input: undefined,
			},
		];
		const e = new InvalidQueryError(issues);
		expect(e).toBeInstanceOf(SessionsError);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("InvalidQueryError");
		expect(e.issues).toBe(issues);
	});

	it("InconsistentSessionRowError instanceof SessionsError + carries sessionId", () => {
		const e = new InconsistentSessionRowError("sess-bad");
		expect(e).toBeInstanceOf(SessionsError);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe("InconsistentSessionRowError");
		expect(e.sessionId).toBe("sess-bad");
	});
});
