import {
	CorruptToolCallJsonError,
	InconsistentSessionRowError,
	InvalidQueryError,
	InvalidSessionIdError,
	SessionNotFoundError,
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

	it("InvalidSessionIdError instanceof SessionsError + carries issues", () => {
		const issues = [
			{
				kind: "validation" as const,
				type: "regex",
				expected: null,
				received: '"bad id"',
				message: "Invalid format",
				input: "bad id",
			},
		];
		const e = new InvalidSessionIdError(issues);
		expect(e).toBeInstanceOf(SessionsError);
		expect(e.name).toBe("InvalidSessionIdError");
		expect(e.issues).toBe(issues);
	});

	it("SessionNotFoundError instanceof SessionsError + carries sessionId", () => {
		const e = new SessionNotFoundError("sess-missing");
		expect(e).toBeInstanceOf(SessionsError);
		expect(e.name).toBe("SessionNotFoundError");
		expect(e.sessionId).toBe("sess-missing");
	});

	it("CorruptToolCallJsonError instanceof SessionsError + carries fields and cause", () => {
		const cause = new SyntaxError("bad json");
		const e = new CorruptToolCallJsonError("sess-1", "turn-1", "args", cause);
		expect(e).toBeInstanceOf(SessionsError);
		expect(e.name).toBe("CorruptToolCallJsonError");
		expect(e.sessionId).toBe("sess-1");
		expect(e.turnId).toBe("turn-1");
		expect(e.field).toBe("args");
		expect(e.cause).toBe(cause);
	});
});
