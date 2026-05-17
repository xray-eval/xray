import * as v from "valibot";

import type { ListSessionsResponse } from "@/server/sessions/sessions.types.ts";
import { ListSessionsResponseSchema } from "@/server/sessions/sessions.types.ts";

import { SessionsInvalidResponseError, SessionsLoadError } from "../conversations/errors.ts";

export interface FetchSessionsParams {
	agentId?: string;
	cursor?: string;
	signal: AbortSignal;
}

/**
 * The single network call to `GET /v1/sessions`. Pure function — no React,
 * no state. Hooks (`useInfiniteQuery`) wrap this; tests call it directly.
 * Validates the response against the server-emitted schema at the boundary
 * per `.claude/rules/boundary-validation.md` §2.
 */
export async function fetchSessions({
	agentId,
	cursor,
	signal,
}: FetchSessionsParams): Promise<ListSessionsResponse> {
	const url = new URL("/v1/sessions", window.location.origin);
	if (agentId !== undefined) url.searchParams.set("agentId", agentId);
	if (cursor !== undefined) url.searchParams.set("cursor", cursor);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new SessionsLoadError(res.status);
	const parsed = v.safeParse(ListSessionsResponseSchema, await res.json());
	if (!parsed.success) throw new SessionsInvalidResponseError(parsed.issues);
	return parsed.output;
}
