import { bytesToBase64 } from "./base64.ts";
import { describe, expect, it } from "bun:test";

describe("bytesToBase64", () => {
	it("encodes an empty array", () => {
		expect(bytesToBase64(new Uint8Array(0))).toBe("");
	});

	it("matches Buffer's base64 for a short payload", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
		expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
	});

	it("matches Buffer's base64 across the chunk boundary (>32KiB)", () => {
		const bytes = new Uint8Array(0x8000 + 17);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
		expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
	});
});
