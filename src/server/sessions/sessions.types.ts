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

const RoleSchema = v.picklist(["user", "agent", "tool", "system"]);

/**
 * Wire shape of a tool call within a turn. `args` / `result` are JSON-parsed
 * server-side from `tool_calls.{args,result}_json` so the client never sees
 * the raw string — the column choice is a storage detail, not a wire detail.
 */
export const ConversationToolCallSchema = v.object({
	idx: v.number(),
	name: v.string(),
	args: v.unknown(),
	result: v.unknown(),
	latencyMs: v.nullable(v.number()),
});
export type ConversationToolCall = v.InferOutput<typeof ConversationToolCallSchema>;

/**
 * Wire shape of one transcript turn. Flattens the store's `TurnRow` (the
 * graph-routing columns like `activeNodeId` / `edgeFiredId` are not part of
 * the transcript view — they belong to the graph slice). Tool calls are
 * inlined under each turn rather than fetched on demand: the inspector
 * already needs them to render the expandable block, and a separate fetch
 * round-trip per turn would be a UX regression.
 */
export const ConversationTurnSchema = v.object({
	id: v.string(),
	idx: v.number(),
	role: RoleSchema,
	text: v.string(),
	timestamp: v.string(),
	responseLatencyMs: v.nullable(v.number()),
	interrupted: v.nullable(v.boolean()),
	interruptedAtMs: v.nullable(v.number()),
	toolCalls: v.array(ConversationToolCallSchema),
});
export type ConversationTurn = v.InferOutput<typeof ConversationTurnSchema>;

/**
 * Wire shape of `GET /v1/sessions/:id`. Mirrors `SessionListItem`'s fields
 * for the metadata block, then carries the full ordered turn list.
 */
export const ConversationSchema = v.object({
	id: v.string(),
	agentId: v.string(),
	startedAt: v.string(),
	endedAt: v.nullable(v.string()),
	durationMs: v.nullable(v.number()),
	source: v.union([
		v.literal("ingest"),
		...ALL_PROVIDERS.map((p) => v.literal(`adapter:${p}` as const)),
	]),
	turns: v.array(ConversationTurnSchema),
});
export type Conversation = v.InferOutput<typeof ConversationSchema>;
