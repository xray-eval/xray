import { StoreError, StoreParentDirNotFoundError } from "./errors.ts";
import { describe, expect, it } from "bun:test";

describe("StoreError", () => {
	it("is an Error subclass with a stable name", () => {
		const err = new StoreError("anything");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("StoreError");
		expect(err.message).toBe("anything");
	});
});

describe("StoreParentDirNotFoundError", () => {
	it("is catchable as StoreError (and as Error)", () => {
		const err = new StoreParentDirNotFoundError("/data/xray.db", "/data");
		expect(err).toBeInstanceOf(StoreError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("StoreParentDirNotFoundError");
	});

	it("exposes the offending path and parent as typed fields", () => {
		const err = new StoreParentDirNotFoundError("/srv/xray/xray.db", "/srv/xray");
		expect(err.path).toBe("/srv/xray/xray.db");
		expect(err.parent).toBe("/srv/xray");
	});

	it("formats a message that names both path and parent", () => {
		const err = new StoreParentDirNotFoundError("/missing/x.db", "/missing");
		expect(err.message).toContain("/missing/x.db");
		expect(err.message).toContain("/missing");
	});
});
