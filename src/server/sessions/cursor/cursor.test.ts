import { encodeCursor, tryDecodeCursor } from "./cursor.ts";
import { describe, expect, it } from "bun:test";

describe("cursor", () => {
	it("round-trips a payload through encode and decode", () => {
		const payload = { startedAt: "2026-05-16T12:00:00.000Z", id: "sess-1" };
		const decoded = tryDecodeCursor(encodeCursor(payload));
		expect(decoded).toEqual(payload);
	});

	it("returns undefined for a string that is not base64url", () => {
		expect(tryDecodeCursor("!!!not-base64!!!")).toBeUndefined();
	});

	it("returns undefined for base64url that decodes to non-JSON", () => {
		const bad = Buffer.from("not json", "utf8").toString("base64url");
		expect(tryDecodeCursor(bad)).toBeUndefined();
	});

	it("returns undefined for JSON of the wrong shape", () => {
		const bad = Buffer.from(JSON.stringify({ nope: 1 }), "utf8").toString("base64url");
		expect(tryDecodeCursor(bad)).toBeUndefined();
	});

	it("returns undefined for a non-ISO startedAt", () => {
		const bad = Buffer.from(JSON.stringify({ startedAt: "tomorrow", id: "x" }), "utf8").toString(
			"base64url",
		);
		expect(tryDecodeCursor(bad)).toBeUndefined();
	});
});
