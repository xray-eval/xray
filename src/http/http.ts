import ky, { HTTPError, NetworkError, TimeoutError } from "ky";
import * as v from "valibot";

import {
	HttpNetworkError,
	HttpRequestFailedError,
	HttpResponseShapeError,
	HttpTimeoutError,
} from "./errors.ts";
import type { HttpClient, HttpClientOptions, HttpGetOptions } from "./types.ts";

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createHttpClient(opts: HttpClientOptions): HttpClient {
	const attempts = opts.retry ?? DEFAULT_RETRY_ATTEMPTS;
	const kyOptions: Parameters<typeof ky.create>[0] = {
		// `baseUrl` does standard URL resolution — leading slash on input means
		// "absolute path from origin", which matches how every adapter writes paths.
		baseUrl: opts.baseUrl,
		// ky's `retry.limit` is *additional* attempts on top of the first.
		retry: { limit: Math.max(0, attempts - 1), methods: ["get"] },
		timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
	if (opts.headers) {
		kyOptions.headers = opts.headers;
	}
	const instance = ky.create(kyOptions);

	return {
		async get(path, schema, options) {
			let raw: unknown;
			try {
				const requestInit: HttpGetOptions = {};
				if (options?.searchParams) {
					requestInit.searchParams = options.searchParams;
				}
				raw = await instance.get(path, requestInit).json();
			} catch (e) {
				if (e instanceof HTTPError) {
					// ky pre-parses the body into `e.data` and consumes the response —
					// reading `e.response.text()` would yield empty.
					const body = typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "");
					throw new HttpRequestFailedError(e.response.url, e.response.status, body);
				}
				if (e instanceof TimeoutError) {
					throw new HttpTimeoutError(e.request.url, { cause: e });
				}
				if (e instanceof NetworkError) {
					throw new HttpNetworkError(e.request.url, { cause: e });
				}
				throw e;
			}
			const result = v.safeParse(schema, raw);
			if (!result.success) {
				throw new HttpResponseShapeError(joinUrl(opts.baseUrl, path, options), result.issues);
			}
			return result.output;
		},
	};
}

function joinUrl(baseUrl: string, path: string, options?: HttpGetOptions): string {
	const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	if (options?.searchParams) {
		for (const [key, value] of Object.entries(options.searchParams)) {
			url.searchParams.set(key, String(value));
		}
	}
	return url.toString();
}
