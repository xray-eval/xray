import * as v from "valibot";

import {
	MAX_DURATION_MS,
	MAX_TOOL_NAME,
	MAX_TURN_TEXT,
	RoleSchema,
	SessionIdSchema,
} from "@/server/ingest/ingest.types.ts";
import type { ReplayRunMode, ReplayRunStatus } from "@/server/store/types.ts";
import { REPLAY_RUN_MODES, REPLAY_RUN_STATUSES } from "@/server/store/types.ts";

// Wire-shared schemas for the agent-replay surface.
// - Request body for `POST /v1/replays` and response for `GET /v1/replays/:id`.
// - Webhook contract (what xray POSTs to the user's URL and what it expects back).
// The webhook shapes are deliberately framework-agnostic: any HTTP server in
// any language can implement them.

const MAX_WEBHOOK_URL = 2048;
const MAX_TOOL_CALLS_PER_TURN = 64;
const MAX_HISTORY = 1024;

export const ReplayStatusSchema = v.picklist(REPLAY_RUN_STATUSES);
export type ReplayStatus = ReplayRunStatus;

export const ReplayModeSchema = v.picklist(REPLAY_RUN_MODES);
export type ReplayMode = ReplayRunMode;

/**
 * Body of `POST /v1/replays`. The webhook URL must be parseable as a URL and
 * must use `http:` or `https:` — `file://`, `gopher://`, `javascript:` etc.
 * are rejected at the boundary so the worker's `fetch` can never be coerced
 * into reading from the filesystem or following non-HTTP schemes. SSRF against
 * internal HTTP hosts (cloud metadata, localhost services) is NOT prevented
 * here — see `replays.service.ts` where `redirect: "manual"` blocks chained
 * redirects to internal endpoints, and the README for the residual operator
 * threat model.
 */
const HTTP_URL_SCHEMES = new Set(["http:", "https:"]);
export const CreateReplayRequestSchema = v.object({
	sourceSessionId: SessionIdSchema,
	webhookUrl: v.pipe(
		v.string(),
		v.url(),
		v.maxLength(MAX_WEBHOOK_URL),
		v.check((u) => {
			try {
				return HTTP_URL_SCHEMES.has(new URL(u).protocol);
			} catch {
				return false;
			}
		}, "Webhook URL must use http or https"),
	),
});
export type CreateReplayRequest = v.InferOutput<typeof CreateReplayRequestSchema>;

/**
 * Response of `POST /v1/replays` and `GET /v1/replays/:id`. Same shape so a
 * client polling progress doesn't need to branch on which call it's reading.
 */
export const ReplayRunResponseSchema = v.object({
	id: v.string(),
	sourceSessionId: v.string(),
	targetSessionId: v.string(),
	status: ReplayStatusSchema,
	mode: ReplayModeSchema,
	progress: v.object({
		completed: v.number(),
		total: v.number(),
	}),
	startedAt: v.string(),
	finishedAt: v.nullable(v.string()),
	error: v.nullable(v.string()),
});
export type ReplayRunResponse = v.InferOutput<typeof ReplayRunResponseSchema>;

/**
 * Webhook request body. Sent as `POST {webhookUrl}` once per user turn in
 * the source session. `recordedToolResults` carries the original agent's
 * tool calls + results — the webhook decides whether to re-use them or
 * call real tools again.
 */
export const WebhookRequestSchema = v.object({
	sessionId: v.string(),
	turnIdx: v.number(),
	userText: v.string(),
	history: v.array(
		v.object({
			role: RoleSchema,
			text: v.string(),
		}),
	),
	recordedToolResults: v.array(
		v.object({
			name: v.string(),
			args: v.unknown(),
			result: v.unknown(),
		}),
	),
});
export type WebhookRequest = v.InferOutput<typeof WebhookRequestSchema>;

/**
 * Webhook response body. The contract is intentionally narrow — `agentText`
 * is the only required field. `toolCalls` defaults to empty, the latency and
 * barge-in fields are optional. Voice-to-voice loops set them; text-only loops
 * don't.
 */
export const WebhookResponseSchema = v.object({
	agentText: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
	toolCalls: v.optional(
		v.pipe(
			v.array(
				v.object({
					name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
					args: v.unknown(),
				}),
			),
			v.maxLength(MAX_TOOL_CALLS_PER_TURN),
		),
		[],
	),
	responseLatencyMs: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DURATION_MS)),
	),
	interrupted: v.optional(v.boolean()),
});
export type WebhookResponse = v.InferOutput<typeof WebhookResponseSchema>;

export const REPLAY_HISTORY_CAP = MAX_HISTORY;

/** Path-param schema for `GET /v1/replays/:id`. UUID v4-ish (any UUID shape works). */
export const ReplayIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-fA-F-]{36}$/, "Must be a UUID"));

/**
 * Response of `GET /v1/sessions/:sessionId/replays`. Wraps `items` so a future
 * `nextCursor` can slot in without breaking clients — pagination isn't required
 * for v1 (replay counts per session are small) but the envelope is.
 */
export const ListReplayRunsResponseSchema = v.object({
	items: v.array(ReplayRunResponseSchema),
});
export type ListReplayRunsResponse = v.InferOutput<typeof ListReplayRunsResponseSchema>;
