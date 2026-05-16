import type * as v from "valibot";

export interface HttpClientOptions {
	baseUrl: string;
	headers?: Record<string, string>;
	/**
	 * Total attempts including the first. `1` disables retries. ky retries the
	 * GET method by default on the standard retryable statuses (408, 413, 429,
	 * 5xx). Default: 3.
	 */
	retry?: number;
	/** Per-request timeout in milliseconds. Default: 10_000. */
	timeoutMs?: number;
}

export interface HttpGetOptions {
	/** Query-string parameters. ky encodes them; do not pre-encode. */
	searchParams?: Record<string, string | number | boolean>;
}

export interface HttpClient {
	get<S extends v.GenericSchema>(
		path: string,
		schema: S,
		options?: HttpGetOptions,
	): Promise<v.InferOutput<S>>;
}
