import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	BodyTooLargeResponseSchema,
	openApiSchemaFromValibot,
	ReplayNotFoundResponseSchema,
	SessionNotFoundResponseSchema,
	StoreFailureResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { SessionIdSchema } from "@/server/ingest/ingest.types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import { SessionNotFoundError } from "@/server/sessions/sessions.errors.ts";
import { getReplayRun } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";

import {
	BodyTooLargeError,
	InvalidReplayIdError,
	InvalidReplayRequestError,
	InvalidSessionIdError,
	MalformedBodyError,
	ReplayRunNotFoundError,
	SourceSessionNotFoundError,
} from "./replays.errors.ts";
import {
	createReplay,
	listReplaysForSession,
	runReplay,
	toReplayRunResponse,
} from "./replays.service.ts";
import {
	CreateReplayRequestSchema,
	ListReplayRunsResponseSchema,
	ReplayIdSchema,
	ReplayRunResponseSchema,
} from "./replays.types.ts";

/** Body is just `{sourceSessionId, webhookUrl}`; even with a 2KB URL the worst case fits well under 4KB. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Fire-and-forget: `POST /v1/replays` returns 202 the moment the row is in
 * the store. The worker runs in the background on the same Bun process;
 * status flows back through `GET /v1/replays/:id`. SSE streaming
 * (`/v1/replays/:id/stream`) is deferred until #15.
 */
export function createReplaysRouter(store: Store): Hono {
	const router = new Hono();

	router.post(
		"/replays",
		describeRoute({
			tags: ["Replays"],
			summary: "Start a text-replay run",
			description:
				"Re-runs a recorded session through your text webhook. xray POSTs each user turn from the source session to `webhookUrl`; your webhook returns the new agent text (and optionally tool calls / latency). The body shape xray sends and the response shape it expects are documented under `webhooks.textReplay`. Returns 202 immediately — poll `GET /v1/replays/:id` for progress.",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: openApiSchemaFromValibot(CreateReplayRequestSchema) },
				},
			},
			responses: {
				"202": {
					description: "Replay run created; worker started.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayRunResponseSchema) },
					},
				},
				"400": {
					description: "Body failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Source session not found.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(SessionNotFoundResponseSchema) },
					},
				},
				"413": {
					description: "Body exceeded the 4 KB cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
				"500": {
					description: "Unhandled internal failure.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(StoreFailureResponseSchema) },
					},
				},
			},
		}),
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: () => {
				throw new BodyTooLargeError(MAX_BODY_BYTES);
			},
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedBodyError({ cause });
			}
			const parsed = v.safeParse(CreateReplayRequestSchema, raw);
			if (!parsed.success) {
				throw new InvalidReplayRequestError(parsed.issues);
			}

			const row = createReplay(store, parsed.output);

			// Fire-and-forget worker. Errors update the run row's `error` column;
			// log here because no caller is awaiting this promise.
			void runReplay({ store, runId: row.id }).catch((err) => {
				console.error(`replay ${row.id} failed`, err);
			});

			return c.json(toReplayRunResponse(row), 202);
		},
	);

	router.get(
		"/sessions/:sessionId/replays",
		describeRoute({
			tags: ["Replays"],
			summary: "List replay runs for a session",
			description:
				"Returns every replay whose `sourceSessionId` matches this session, newest-first. Powers the inspector's Replays tab. No pagination — replay counts per session are small.",
			parameters: [
				{
					in: "path",
					name: "sessionId",
					required: true,
					schema: openApiSchemaFromValibot(SessionIdSchema),
				},
			],
			responses: {
				"200": {
					description: "Replay runs for the session (possibly empty).",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ListReplayRunsResponseSchema),
						},
					},
				},
				"400": {
					description: "Session id failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Session not found.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(SessionNotFoundResponseSchema) },
					},
				},
			},
		}),
		(c) => {
			const idCheck = v.safeParse(SessionIdSchema, c.req.param("sessionId"));
			if (!idCheck.success) {
				throw new InvalidSessionIdError(idCheck.issues);
			}
			return c.json(listReplaysForSession(store, idCheck.output));
		},
	);

	router.get(
		"/replays/:id",
		describeRoute({
			tags: ["Replays"],
			summary: "Get one replay run's status",
			description:
				"Shared by text and realtime replays — both flavors share the same row shape. Poll until `status` is `completed` or `failed`.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					description:
						"Replay run UUID (returned by `POST /v1/replays` or `POST /v1/replays/realtime`).",
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
			],
			responses: {
				"200": {
					description: "Replay run row.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayRunResponseSchema) },
					},
				},
				"400": {
					description: "Replay id is not a UUID.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "No replay run with that id.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayNotFoundResponseSchema) },
					},
				},
			},
		}),
		(c) => {
			const idCheck = v.safeParse(ReplayIdSchema, c.req.param("id"));
			if (!idCheck.success) {
				throw new InvalidReplayIdError(idCheck.issues);
			}
			const row = getReplayRun(store.db, idCheck.output);
			if (row === undefined) {
				throw new ReplayRunNotFoundError(idCheck.output);
			}
			return c.json(toReplayRunResponse(row));
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(
				P.union(P.instanceOf(InvalidReplayRequestError), P.instanceOf(MalformedBodyError)),
				(e) => c.json({ error: "invalid_replay_request", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(BodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", maxBytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(InvalidReplayIdError), (e) =>
				c.json({ error: "invalid_replay_id", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(InvalidSessionIdError), (e) =>
				c.json({ error: "invalid_session_id", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(SourceSessionNotFoundError), (e) =>
				c.json({ error: "source_session_not_found", sessionId: e.sessionId }, 404),
			)
			.with(P.instanceOf(SessionNotFoundError), (e) =>
				c.json({ error: "session_not_found", sessionId: e.sessionId }, 404),
			)
			.with(P.instanceOf(ReplayRunNotFoundError), (e) =>
				c.json({ error: "replay_not_found", replayId: e.replayId }, 404),
			)
			.otherwise((e) => {
				console.error("unhandled error during replay", e);
				return c.json({ error: "internal_error" }, 500);
			}),
	);

	return router;
}
