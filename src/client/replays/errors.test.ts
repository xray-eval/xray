import * as v from "valibot";

import { ReplayInvalidResponseError, ReplayLoadError, ReplaysError } from "./errors.ts";
import { describe, expect, it } from "bun:test";

describe("ReplaysError", () => {
	it("is an Error subclass with a stable name", () => {
		const err = new ReplaysError("boom");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ReplaysError");
		expect(err.message).toBe("boom");
	});
});

describe("ReplayLoadError", () => {
	it("is catchable as ReplaysError and exposes status", () => {
		const err = new ReplayLoadError(500);
		expect(err).toBeInstanceOf(ReplaysError);
		expect(err.name).toBe("ReplayLoadError");
		expect(err.status).toBe(500);
	});

	it("defaults the message to include the status", () => {
		const err = new ReplayLoadError(404);
		expect(err.message).toContain("404");
	});

	it("preserves a custom message when provided", () => {
		const err = new ReplayLoadError(404, "Replay not found in workspace");
		expect(err.message).toBe("Replay not found in workspace");
	});
});

describe("ReplayInvalidResponseError", () => {
	it("is catchable as ReplaysError and exposes Valibot issues", () => {
		const issues = (() => {
			const r = v.safeParse(v.object({ id: v.string() }), {});
			return r.success ? [] : r.issues;
		})();
		const err = new ReplayInvalidResponseError(issues);
		expect(err).toBeInstanceOf(ReplaysError);
		expect(err.name).toBe("ReplayInvalidResponseError");
		expect(err.issues).toEqual(issues);
	});
});
