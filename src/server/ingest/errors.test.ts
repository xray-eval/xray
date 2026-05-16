import * as v from "valibot";

import { IngestError, InvalidEventError, UnknownTurnError } from "./errors.ts";
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
