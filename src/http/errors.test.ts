import { describe, expect, it } from "vitest";

import {
	HttpClientError,
	HttpNetworkError,
	HttpRequestFailedError,
	HttpResponseShapeError,
	HttpTimeoutError,
} from "./errors.ts";

describe("HttpRequestFailedError", () => {
	it("is catchable as HttpClientError (and as Error)", () => {
		const err = new HttpRequestFailedError("https://x/v1/agents", 401, "Unauthorized");
		expect(err).toBeInstanceOf(HttpClientError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("HttpRequestFailedError");
	});

	it("exposes url, status, and body as typed fields", () => {
		const err = new HttpRequestFailedError("https://x/v1/agents/xyz", 404, "Not found");
		expect(err.url).toBe("https://x/v1/agents/xyz");
		expect(err.status).toBe(404);
		expect(err.body).toBe("Not found");
	});

	it("formats a message naming status and url", () => {
		const err = new HttpRequestFailedError("https://x/v1/agents", 500, "");
		expect(err.message).toContain("500");
		expect(err.message).toContain("https://x/v1/agents");
	});
});

describe("HttpResponseShapeError", () => {
	it("is catchable as HttpClientError and carries the url + valibot issues", () => {
		const issues = [
			{
				kind: "schema",
				type: "string",
				input: 1,
				expected: "string",
				received: "1",
				message: "Invalid type: Expected string but received 1",
			},
		] as const;
		const err = new HttpResponseShapeError("https://x/v1/agents", issues);
		expect(err).toBeInstanceOf(HttpClientError);
		expect(err.name).toBe("HttpResponseShapeError");
		expect(err.url).toBe("https://x/v1/agents");
		expect(err.issues).toEqual(issues);
	});
});

describe("HttpTimeoutError", () => {
	it("is catchable as HttpClientError and exposes the url", () => {
		const cause = new Error("upstream timeout");
		const err = new HttpTimeoutError("https://x/v1/agents", { cause });
		expect(err).toBeInstanceOf(HttpClientError);
		expect(err.name).toBe("HttpTimeoutError");
		expect(err.url).toBe("https://x/v1/agents");
		expect(err.cause).toBe(cause);
	});
});

describe("HttpNetworkError", () => {
	it("is catchable as HttpClientError and exposes the url", () => {
		const cause = new Error("ECONNREFUSED");
		const err = new HttpNetworkError("https://x/v1/agents", { cause });
		expect(err).toBeInstanceOf(HttpClientError);
		expect(err.name).toBe("HttpNetworkError");
		expect(err.url).toBe("https://x/v1/agents");
		expect(err.cause).toBe(cause);
	});
});
