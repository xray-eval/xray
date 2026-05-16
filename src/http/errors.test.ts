import { describe, expect, it } from "vitest";

import { HttpClientError, HttpRequestFailedError, HttpResponseShapeError } from "./errors.ts";

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
