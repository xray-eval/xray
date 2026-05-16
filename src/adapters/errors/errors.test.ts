import { describe, expect, it } from "vitest";

import { AdapterError, DuplicateAdapterError } from "./errors.ts";

describe("AdapterError", () => {
	it("is an Error subclass with a stable name", () => {
		const err = new AdapterError("anything");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("AdapterError");
		expect(err.message).toBe("anything");
	});
});

describe("DuplicateAdapterError", () => {
	it("is catchable as AdapterError (and as Error)", () => {
		const err = new DuplicateAdapterError("elevenlabs");
		expect(err).toBeInstanceOf(AdapterError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("DuplicateAdapterError");
	});

	it("exposes the offending provider as a typed field", () => {
		const err = new DuplicateAdapterError("vapi");
		expect(err.provider).toBe("vapi");
	});

	it("formats a message that names the provider", () => {
		const err = new DuplicateAdapterError("retell");
		expect(err.message).toContain("retell");
	});
});
