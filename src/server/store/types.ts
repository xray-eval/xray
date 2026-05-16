import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type { sessions, toolCalls, turns } from "./schema.ts";

export type SessionSource = "adapter" | "ingest";

/**
 * A unified session record. Covers provider-adapter polls (source='adapter',
 * provider set) and HTTP ingest pushes (source='ingest', provider null).
 *
 * Derived from the Drizzle schema in `schema.ts` — adding a column there
 * automatically widens this type.
 */
export type Session = InferSelectModel<typeof sessions>;

/**
 * One conversation step persisted in `turns`. Mirrors `Turn` from
 * `@/adapters/types.ts` but flattens tool calls into a separate table.
 */
export type TurnRow = InferSelectModel<typeof turns>;

/** Builder shape for `appendTurns` — `sessionId` is filled by the repo. */
export type TurnInput = Omit<InferInsertModel<typeof turns>, "sessionId">;

/**
 * One tool invocation persisted in `tool_calls`. `argsJson` / `resultJson`
 * stay as JSON-encoded strings — the inspector deserializes on display so
 * the DB stays schema-agnostic about tool payload shapes.
 */
export type ToolCallRow = InferSelectModel<typeof toolCalls>;

/** Builder shape for `appendToolCalls` — `id` is auto-assigned, `turnId` comes from the arg. */
export type ToolCallInput = Omit<InferInsertModel<typeof toolCalls>, "id" | "turnId">;
