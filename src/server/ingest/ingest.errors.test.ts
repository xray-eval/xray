import * as v from "valibot";

import {
	BodyTooLargeError,
	IngestError,
	InvalidEventError,
	MalformedBodyError,
	UnknownTurnError,
} from "./ingest.errors.ts";
import { describe, expect, it } from "bun:test";

describe("IngestError", () => {
	it("is an Error subclass with a stable name", () => {
		const err = new IngestError("boom");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("IngestError");
		expect(err.message).toBe("boom");
	});
});

describe("InvalidEventError", () => {
	it("is catchable as IngestError (and as Error)", () => {
		const err = new InvalidEventError("s-1", []);
		expect(err).toBeInstanceOf(IngestError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("InvalidEventError");
	});

	it("exposes sessionId and the Valibot issues as typed fields", () => {
		const result = v.safeParse(v.object({ foo: v.string() }), {});
		const issues = result.success ? [] : result.issues;
		const err = new InvalidEventError("s-1", issues);
		expect(err.sessionId).toBe("s-1");
		expect(err.issues).toEqual(issues);
	});
});

describe("MalformedBodyError", () => {
	it("is catchable as IngestError", () => {
		const err = new MalformedBodyError("s-1");
		expect(err).toBeInstanceOf(IngestError);
		expect(err.name).toBe("MalformedBodyError");
	});

	it("synthesizes a BaseIssue so the 400 response shape matches InvalidEventError", () => {
		const err = new MalformedBodyError("s-1");
		expect(err.issues).toHaveLength(1);
		const [issue] = err.issues;
		expect(issue?.kind).toBe("schema");
		expect(typeof issue?.message).toBe("string");
	});

	it("wraps the underlying SyntaxError via `cause`", () => {
		const underlying = new SyntaxError("Unexpected token n in JSON");
		const err = new MalformedBodyError("s-1", { cause: underlying });
		expect(err.cause).toBe(underlying);
	});
});

describe("BodyTooLargeError", () => {
	it("is catchable as IngestError and exposes maxBytes", () => {
		const err = new BodyTooLargeError(1024);
		expect(err).toBeInstanceOf(IngestError);
		expect(err.name).toBe("BodyTooLargeError");
		expect(err.maxBytes).toBe(1024);
	});
});

describe("UnknownTurnError", () => {
	it("is catchable as IngestError (and as Error)", () => {
		const err = new UnknownTurnError("s-1", 3);
		expect(err).toBeInstanceOf(IngestError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("UnknownTurnError");
	});

	it("exposes sessionId and turnIdx as typed fields", () => {
		const err = new UnknownTurnError("s-1", 7);
		expect(err.sessionId).toBe("s-1");
		expect(err.turnIdx).toBe(7);
		expect(err.message).toContain("s-1");
		expect(err.message).toContain("7");
	});
});
