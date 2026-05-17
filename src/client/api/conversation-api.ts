import * as v from "valibot";

import type { Conversation } from "@/server/sessions/sessions.types.ts";
import { ConversationSchema } from "@/server/sessions/sessions.types.ts";

import { ConversationInvalidResponseError, ConversationLoadError } from "../inspector/errors.ts";

export interface FetchConversationParams {
	sessionId: string;
	signal: AbortSignal;
}

/**
 * Single network call to `GET /v1/sessions/:id`.
 *
 * Throws `ConversationLoadError` on non-2xx and
 * `ConversationInvalidResponseError` when the body doesn't match
 * `ConversationSchema`.
 */
export async function fetchConversation({
	sessionId,
	signal,
}: FetchConversationParams): Promise<Conversation> {
	const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}`, window.location.origin);
	const res = await fetch(url, { signal });
	if (!res.ok) throw new ConversationLoadError(res.status);
	const parsed = v.safeParse(ConversationSchema, await res.json());
	if (!parsed.success) throw new ConversationInvalidResponseError(parsed.issues);
	return parsed.output;
}
