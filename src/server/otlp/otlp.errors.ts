import type { BaseIssue } from "valibot";

export class OtlpError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OtlpError";
	}
}

const MALFORMED_BODY_ISSUES: readonly BaseIssue<unknown>[] = Object.freeze([
	{
		kind: "schema",
		type: "json_body",
		input: undefined,
		expected: "valid JSON",
		received: "unparseable text",
		message: "Request body must be valid OTLP/JSON",
	},
]);

export class InvalidOtlpBodyError extends OtlpError {
	readonly issues: readonly BaseIssue<unknown>[];
	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid OTLP body");
		this.name = "InvalidOtlpBodyError";
		this.issues = issues;
	}
}

export class MalformedOtlpBodyError extends OtlpError {
	readonly issues: readonly BaseIssue<unknown>[] = MALFORMED_BODY_ISSUES;
	constructor(options?: ErrorOptions) {
		super("Request body must be valid OTLP/JSON", options);
		this.name = "MalformedOtlpBodyError";
	}
}

/** Body exceeded the per-request byte cap. */
export class OtlpBodyTooLargeError extends OtlpError {
	readonly maxBytes: number;
	constructor(maxBytes: number) {
		super(`Body exceeds ${maxBytes} bytes`);
		this.name = "OtlpBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}

/** Request contained more spans than the per-request cap. */
export class TooManySpansPerRequestError extends OtlpError {
	readonly maxSpans: number;
	readonly received: number;
	constructor(maxSpans: number, received: number) {
		super(`Request contains ${received} spans; cap is ${maxSpans} per request`);
		this.name = "TooManySpansPerRequestError";
		this.maxSpans = maxSpans;
		this.received = received;
	}
}

export class UnsupportedOtlpContentTypeError extends OtlpError {
	readonly contentType: string | null;
	constructor(contentType: string | null) {
		super(
			contentType === null
				? "Missing Content-Type — only application/json is accepted"
				: `Content-Type "${contentType}" is not supported (use application/json)`,
		);
		this.name = "UnsupportedOtlpContentTypeError";
		this.contentType = contentType;
	}
}
