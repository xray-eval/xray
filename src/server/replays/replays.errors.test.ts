import * as v from "valibot";

import {
	BodyTooLargeError,
	CorruptToolCallJsonError,
	InvalidReplayIdError,
	InvalidReplayRequestError,
	InvalidSessionIdError,
	MalformedBodyError,
	ReplayError,
	ReplayRunNotFoundError,
	SourceSessionNotFoundError,
	WebhookFetchError,
	WebhookHttpError,
	WebhookResponseNotJsonError,
	WebhookResponseShapeError,
} from "./replays.errors.ts";
import { describe, expect, it } from "bun:test";

describe("ReplayError", () => {
	it("is an Error subclass with a stable name", () => {
		const err = new ReplayError("boom");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ReplayError");
		expect(err.message).toBe("boom");
	});
});

describe("InvalidReplayRequestError", () => {
	it("is catchable as ReplayError and exposes Valibot issues", () => {
		const issues = (() => {
			const r = v.safeParse(v.object({ foo: v.string() }), {});
			return r.success ? [] : r.issues;
		})();
		const err = new InvalidReplayRequestError(issues);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("InvalidReplayRequestError");
		expect(err.issues).toEqual(issues);
	});
});

describe("MalformedBodyError", () => {
	it("is catchable as ReplayError", () => {
		const err = new MalformedBodyError();
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("MalformedBodyError");
	});

	it("synthesizes a BaseIssue so the 400 response shape matches InvalidReplayRequestError", () => {
		const err = new MalformedBodyError();
		expect(err.issues).toHaveLength(1);
		const [issue] = err.issues;
		expect(issue?.kind).toBe("schema");
		expect(typeof issue?.message).toBe("string");
	});

	it("wraps the underlying SyntaxError via cause", () => {
		const underlying = new SyntaxError("Unexpected token n in JSON");
		const err = new MalformedBodyError({ cause: underlying });
		expect(err.cause).toBe(underlying);
	});
});

describe("BodyTooLargeError", () => {
	it("is catchable as ReplayError and exposes maxBytes", () => {
		const err = new BodyTooLargeError(4096);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("BodyTooLargeError");
		expect(err.maxBytes).toBe(4096);
	});
});

describe("InvalidReplayIdError", () => {
	it("is catchable as ReplayError and exposes issues", () => {
		const issues = (() => {
			const r = v.safeParse(v.string(), 42);
			return r.success ? [] : r.issues;
		})();
		const err = new InvalidReplayIdError(issues);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("InvalidReplayIdError");
		expect(err.issues).toEqual(issues);
	});
});

describe("ReplayRunNotFoundError", () => {
	it("is catchable as ReplayError and exposes replayId", () => {
		const err = new ReplayRunNotFoundError("r-99");
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("ReplayRunNotFoundError");
		expect(err.replayId).toBe("r-99");
	});
});

describe("SourceSessionNotFoundError", () => {
	it("is catchable as ReplayError and exposes sessionId", () => {
		const err = new SourceSessionNotFoundError("sess-missing");
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("SourceSessionNotFoundError");
		expect(err.sessionId).toBe("sess-missing");
	});
});

describe("InvalidSessionIdError", () => {
	it("is catchable as ReplayError and exposes issues", () => {
		const issues = (() => {
			const r = v.safeParse(v.string(), 42);
			return r.success ? [] : r.issues;
		})();
		const err = new InvalidSessionIdError(issues);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("InvalidSessionIdError");
		expect(err.issues).toEqual(issues);
	});
});

describe("WebhookHttpError", () => {
	it("is catchable as ReplayError and exposes status", () => {
		const err = new WebhookHttpError(503);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("WebhookHttpError");
		expect(err.status).toBe(503);
	});
});

describe("WebhookResponseShapeError", () => {
	it("is catchable as ReplayError and exposes issues", () => {
		const issues = (() => {
			const r = v.safeParse(v.object({ agentText: v.string() }), {});
			return r.success ? [] : r.issues;
		})();
		const err = new WebhookResponseShapeError(issues);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("WebhookResponseShapeError");
		expect(err.issues).toEqual(issues);
	});
});

describe("WebhookResponseNotJsonError", () => {
	it("is catchable as ReplayError and wraps the underlying cause", () => {
		const cause = new SyntaxError("not JSON");
		const err = new WebhookResponseNotJsonError({ cause });
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("WebhookResponseNotJsonError");
		expect(err.cause).toBe(cause);
	});
});

describe("WebhookFetchError", () => {
	it("is catchable as ReplayError, carries the message, and wraps cause", () => {
		const cause = new Error("ECONNREFUSED");
		const err = new WebhookFetchError("Failed to reach webhook: ECONNREFUSED", { cause });
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("WebhookFetchError");
		expect(err.message).toContain("ECONNREFUSED");
		expect(err.cause).toBe(cause);
	});
});

describe("CorruptToolCallJsonError", () => {
	it("is catchable as ReplayError and exposes typed fields", () => {
		const cause = new SyntaxError("Unexpected token");
		const err = new CorruptToolCallJsonError("src-1", "turn-3", "args", cause);
		expect(err).toBeInstanceOf(ReplayError);
		expect(err.name).toBe("CorruptToolCallJsonError");
		expect(err.sessionId).toBe("src-1");
		expect(err.turnId).toBe("turn-3");
		expect(err.field).toBe("args");
		expect(err.cause).toBe(cause);
	});
});
