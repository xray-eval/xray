import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type { replayRuns, sessions, toolCalls, turns } from "./schema.ts";

export type SessionSource = "adapter" | "ingest";

// Single source of truth: the `as const` array is runtime-visible (used
// by Valibot's picklist in `replays.types.ts`) AND the static type. Adding
// a value in one place updates both.
export const REPLAY_RUN_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ReplayRunStatus = (typeof REPLAY_RUN_STATUSES)[number];

/**
 * Replay run flavors. `text` is the HTTP-webhook flow (text → text per turn);
 * `realtime` is the WebSocket V2V flow (recorded user audio → agent audio
 * + transcript per turn). Same `replay_runs` row shape, different worker.
 */
export const REPLAY_RUN_MODES = ["text", "realtime"] as const;
export type ReplayRunMode = (typeof REPLAY_RUN_MODES)[number];

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

/**
 * Persisted replay-run row. One row per `POST /v1/replays` call; the worker
 * walks user turns from `source_session_id` and writes the replayed agent
 * responses into a fresh session whose id is `target_session_id`.
 */
export type ReplayRunRow = InferSelectModel<typeof replayRuns>;

/** Builder shape for `createReplayRun`. */
export type ReplayRunInput = InferInsertModel<typeof replayRuns>;
