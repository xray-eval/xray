import * as v from "valibot";

import { ALL_PROVIDERS } from "@/adapters/types.ts";

// This file contains ONLY wire types shared between server and client.
// Server-only schemas (query parsing, cursor decoding via Node `Buffer`) live
// in `sessions.query.ts` so they cannot leak into the SPA bundle through a
// tree-shaking miss.

/**
 * Wire shape of one session row. Mirrors the store's `Session` minus the raw
 * `source`/`provider` split — the client renders a single source tag, so the
 * server emits `source: "ingest" | "adapter:<provider>"` already composed.
 */
export const SessionListItemSchema = v.object({
	id: v.string(),
	agentId: v.string(),
	startedAt: v.string(),
	endedAt: v.nullable(v.string()),
	durationMs: v.nullable(v.number()),
	source: v.union([
		v.literal("ingest"),
		...ALL_PROVIDERS.map((p) => v.literal(`adapter:${p}` as const)),
	]),
});
export type SessionListItem = v.InferOutput<typeof SessionListItemSchema>;

export const ListSessionsResponseSchema = v.object({
	sessions: v.array(SessionListItemSchema),
	/** Opaque base64url string the client must echo back as `?cursor=...` for the next page. */
	nextCursor: v.nullable(v.string()),
});
export type ListSessionsResponse = v.InferOutput<typeof ListSessionsResponseSchema>;
