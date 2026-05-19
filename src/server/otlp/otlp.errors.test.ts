import {
	InvalidOtlpBodyError,
	MalformedOtlpBodyError,
	OtlpBodyTooLargeError,
	OtlpError,
	TooManySpansPerRequestError,
	UnsupportedOtlpContentTypeError,
} from "./otlp.errors.ts";
import { describe, expect, it } from "bun:test";

describe("OtlpError subclasses", () => {
	it("InvalidOtlpBodyError carries issues + parentage", () => {
		const e = new InvalidOtlpBodyError([
			{
				kind: "schema",
				type: "x",
				input: undefined,
				expected: null,
				received: "undefined",
				message: "m",
			},
		]);
		expect(e).toBeInstanceOf(OtlpError);
		expect(e.name).toBe("InvalidOtlpBodyError");
		expect(e.issues).toHaveLength(1);
	});
	it("MalformedOtlpBodyError exposes a frozen issues array", () => {
		const e = new MalformedOtlpBodyError();
		expect(e.issues[0]?.type).toBe("json_body");
	});
	it("OtlpBodyTooLargeError carries maxBytes", () => {
		const e = new OtlpBodyTooLargeError(4 * 1024 * 1024);
		expect(e.maxBytes).toBe(4 * 1024 * 1024);
	});
	it("TooManySpansPerRequestError carries maxSpans + received", () => {
		const e = new TooManySpansPerRequestError(512, 999);
		expect(e.maxSpans).toBe(512);
		expect(e.received).toBe(999);
	});
	it("UnsupportedOtlpContentTypeError carries contentType", () => {
		const e = new UnsupportedOtlpContentTypeError("application/x-protobuf");
		expect(e.contentType).toBe("application/x-protobuf");
	});
});
