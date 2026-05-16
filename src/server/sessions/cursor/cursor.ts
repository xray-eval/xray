import * as v from "valibot";

import type { CursorPayload } from "./types.ts";
import { CursorPayloadSchema } from "./types.ts";

/**
 * Opaque pagination cursor for `GET /v1/sessions`. Wire format is base64url
 * over a JSON object — clients treat it as a string and echo it back as
 * `?cursor=...`. Encoding lives in one place so the test-utils builder and
 * the route handler can't drift apart.
 */
export function encodeCursor(payload: CursorPayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Returns `undefined` on any decode/shape failure. Callers map that to a
 * domain error (the router emits 400) so a malformed cursor isn't silently
 * treated as page 1 — that would mask client bugs.
 */
export function tryDecodeCursor(raw: string): CursorPayload | undefined {
	try {
		const json = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = v.safeParse(CursorPayloadSchema, JSON.parse(json));
		return parsed.success ? parsed.output : undefined;
	} catch {
		return undefined;
	}
}
