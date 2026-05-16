import { HttpResponse, http } from "msw";
import * as v from "valibot";

import { server } from "@/test-server.ts";

import {
	HttpNetworkError,
	HttpRequestFailedError,
	HttpResponseShapeError,
	HttpTimeoutError,
} from "./errors.ts";
import { createHttpClient } from "./http.ts";
import { describe, expect, it, mock } from "bun:test";

const BASE_URL = "https://api.example.test";

describe("createHttpClient", () => {
	const PingSchema = v.object({ ok: v.boolean() });

	it("performs GET, validates the response, and returns the parsed body", async () => {
		server.use(
			http.get(`${BASE_URL}/v1/ping`, () => HttpResponse.json({ ok: true, extra: "ignored" })),
		);
		const client = createHttpClient({ baseUrl: BASE_URL });

		const data = await client.get("/v1/ping", PingSchema);

		expect(data).toEqual({ ok: true });
	});

	it("sends configured headers on every request", async () => {
		const seen = mock();
		server.use(
			http.get(`${BASE_URL}/v1/ping`, ({ request }) => {
				seen(request.headers.get("x-test-key"));
				return HttpResponse.json({ ok: true });
			}),
		);
		const client = createHttpClient({ baseUrl: BASE_URL, headers: { "x-test-key": "secret" } });

		await client.get("/v1/ping", PingSchema);

		expect(seen).toHaveBeenCalledWith("secret");
	});

	it("encodes searchParams and surfaces them on the wire", async () => {
		const seen = mock();
		server.use(
			http.get(`${BASE_URL}/v1/items`, ({ request }) => {
				seen(new URL(request.url).search);
				return HttpResponse.json({ ok: true });
			}),
		);
		const client = createHttpClient({ baseUrl: BASE_URL });

		await client.get("/v1/items", PingSchema, { searchParams: { id: "weird/value" } });

		expect(seen).toHaveBeenCalledWith("?id=weird%2Fvalue");
	});

	it("throws HttpRequestFailedError on non-2xx with status and body", async () => {
		server.use(
			http.get(`${BASE_URL}/v1/forbidden`, () => HttpResponse.text("nope", { status: 403 })),
		);
		const client = createHttpClient({ baseUrl: BASE_URL, retry: 1 });

		const promise = client.get("/v1/forbidden", PingSchema);
		await expect(promise).rejects.toBeInstanceOf(HttpRequestFailedError);
		await expect(promise).rejects.toMatchObject({
			status: 403,
			body: "nope",
			url: `${BASE_URL}/v1/forbidden`,
		});
	});

	it("throws HttpResponseShapeError when the payload fails schema validation", async () => {
		server.use(http.get(`${BASE_URL}/v1/ping`, () => HttpResponse.json({ ok: "not-a-bool" })));
		const client = createHttpClient({ baseUrl: BASE_URL });

		const promise = client.get("/v1/ping", PingSchema);
		await expect(promise).rejects.toBeInstanceOf(HttpResponseShapeError);
		await expect(promise).rejects.toMatchObject({
			url: `${BASE_URL}/v1/ping`,
		});
	});

	it("retries retryable 5xx responses up to the configured attempt count", async () => {
		const handler = mock<() => Response>()
			.mockReturnValueOnce(HttpResponse.text("boom", { status: 503 }))
			.mockReturnValueOnce(HttpResponse.text("boom", { status: 503 }))
			.mockReturnValueOnce(HttpResponse.json({ ok: true }));
		server.use(http.get(`${BASE_URL}/v1/flaky`, () => handler()));
		const client = createHttpClient({ baseUrl: BASE_URL, retry: 3 });

		const data = await client.get("/v1/flaky", PingSchema);

		expect(data).toEqual({ ok: true });
		expect(handler).toHaveBeenCalledTimes(3);
	});

	it("does not retry when retry: 1 is configured", async () => {
		const handler = mock(() => HttpResponse.text("boom", { status: 503 }));
		server.use(http.get(`${BASE_URL}/v1/flaky`, handler));
		const client = createHttpClient({ baseUrl: BASE_URL, retry: 1 });

		await expect(client.get("/v1/flaky", PingSchema)).rejects.toBeInstanceOf(
			HttpRequestFailedError,
		);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("wraps ky TimeoutError as HttpTimeoutError", async () => {
		server.use(
			http.get(
				`${BASE_URL}/v1/slow`,
				({ request }) =>
					new Promise<Response>((_, reject) => {
						request.signal.addEventListener("abort", () => reject(request.signal.reason), {
							once: true,
						});
					}),
			),
		);
		const client = createHttpClient({ baseUrl: BASE_URL, timeoutMs: 5 });

		await expect(client.get("/v1/slow", PingSchema)).rejects.toBeInstanceOf(HttpTimeoutError);
	});

	it("wraps ky NetworkError as HttpNetworkError", async () => {
		server.use(http.get(`${BASE_URL}/v1/unreachable`, () => HttpResponse.error()));
		const client = createHttpClient({ baseUrl: BASE_URL, retry: 1 });

		await expect(client.get("/v1/unreachable", PingSchema)).rejects.toBeInstanceOf(
			HttpNetworkError,
		);
	});
});
