import type { BaseIssue, BaseSchema } from "valibot";
import * as v from "valibot";

import type { FetchLike } from "./fetch.ts";

/**
 * Tests want to assert a few field values on a JSON response. Doing it via
 * `(await res.json()) as { foo: string }` would need the banned `as` cast.
 * This helper parses the body against an inline Valibot schema, so the
 * test still asserts the shape AND we get typed access without a cast.
 */
export async function readJson<T>(
	res: Response,
	schema: BaseSchema<unknown, T, BaseIssue<unknown>>,
): Promise<T> {
	return v.parse(schema, await res.json());
}

export interface CapturedRequest {
	readonly url: string;
	readonly headers: Headers;
	/**
	 * The request body, normalized for assertions: a JSON string body is
	 * parsed to its value; anything else (FormData, undefined) is passed
	 * through untouched. Provider-client tests narrow it (`instanceof
	 * FormData`, or treat it as the decoded JSON object) at the call site.
	 */
	readonly body: unknown;
}

/**
 * Build a `FetchLike` stub that hands each request to `handler` as a
 * `CapturedRequest` and returns whatever `Response` the handler produces.
 * Shared by every provider-client test (transcription + judges) so the
 * four slices don't each keep a drifting private copy.
 */
export function makeFetch(handler: (req: CapturedRequest) => Response): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(init?.headers ?? {});
		let body: unknown = init?.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {
				/* leave as the raw string */
			}
		}
		return handler({ url, headers, body });
	};
}
