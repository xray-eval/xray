import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	openApiSchemaFromValibot,
	SessionNotFoundResponseSchema,
	StoreFailureResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { SessionIdSchema } from "@/server/ingest/ingest.types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	CorruptToolCallJsonError,
	InconsistentSessionRowError,
	InvalidQueryError,
	InvalidSessionIdError,
	SessionNotFoundError,
} from "./sessions.errors.ts";
import { ListSessionsQuerySchema } from "./sessions.query.ts";
import { getConversationForApi, listSessionsForApi } from "./sessions.service.ts";
import { ConversationSchema, ListSessionsResponseSchema } from "./sessions.types.ts";

/**
 * Sessions router. Mounted at `/v1`; final URLs are
 * `GET /v1/sessions` (list) and `GET /v1/sessions/:id` (transcript view).
 *
 * Source-agnostic: returns rows that arrived via either the ingest endpoint
 * (`POST /v1/sessions/:id/events`) or a provider adapter poll. The route does
 * NOT trigger an adapter sync before reading — that's the job of
 * `/v1/agents/:id/conversations` (issue #14).
 */
export function createSessionsRouter(store: Store): Hono {
	const router = new Hono();

	router.get(
		"/sessions",
		describeRoute({
			tags: ["Sessions"],
			summary: "List sessions",
			description:
				"Paginated reverse-chronological list of sessions. Source-agnostic: rows from the ingest endpoint and from provider adapters are interleaved. Pagination uses an opaque `cursor` — echo it back as `?cursor=...` for the next page.",
			parameters: [
				{
					in: "query",
					name: "agentId",
					required: false,
					description: "Filter to one agent.",
					schema: openApiSchemaFromValibot(ListSessionsQuerySchema.entries.agentId),
				},
				{
					in: "query",
					name: "limit",
					required: false,
					description: "1..200, default 100.",
					schema: openApiSchemaFromValibot(ListSessionsQuerySchema.entries.limit),
				},
				{
					in: "query",
					name: "cursor",
					required: false,
					description: "Opaque cursor from a previous response's `nextCursor`.",
					schema: openApiSchemaFromValibot(ListSessionsQuerySchema.entries.cursor),
				},
			],
			responses: {
				"200": {
					description: "Page of sessions.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ListSessionsResponseSchema) },
					},
				},
				"400": {
					description: "Query failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"500": {
					description: "Data-integrity failure in the store.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(StoreFailureResponseSchema) },
					},
				},
			},
		}),
		(c) => {
			const parsed = v.safeParse(ListSessionsQuerySchema, c.req.query());
			if (!parsed.success) {
				throw new InvalidQueryError(parsed.issues);
			}
			return c.json(listSessionsForApi(store, parsed.output));
		},
	);

	router.get(
		"/sessions/:id",
		describeRoute({
			tags: ["Sessions"],
			summary: "Get one session with its full transcript",
			description:
				"Returns the session metadata plus every turn in order, with each turn's tool calls inlined.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(SessionIdSchema),
				},
			],
			responses: {
				"200": {
					description: "Session and transcript.",
					content: { "application/json": { schema: openApiSchemaFromValibot(ConversationSchema) } },
				},
				"400": {
					description: "Session id failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "No session with that id.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(SessionNotFoundResponseSchema) },
					},
				},
				"500": {
					description: "Data-integrity failure in the store.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(StoreFailureResponseSchema) },
					},
				},
			},
		}),
		(c) => {
			// Shared with ingest so any id we accept on write is legal on read.
			const idCheck = v.safeParse(SessionIdSchema, c.req.param("id"));
			if (!idCheck.success) {
				throw new InvalidSessionIdError(idCheck.issues);
			}
			return c.json(getConversationForApi(store, idCheck.output));
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(P.instanceOf(InvalidQueryError), (e) =>
				c.json({ error: "invalid_query", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(InvalidSessionIdError), (e) =>
				c.json({ error: "invalid_session_id", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(SessionNotFoundError), (e) =>
				c.json({ error: "session_not_found", sessionId: e.sessionId }, 404),
			)
			.with(
				P.union(P.instanceOf(InconsistentSessionRowError), P.instanceOf(CorruptToolCallJsonError)),
				(e) => {
					// Both are data-integrity failures the writers cannot produce — log
					// and 500 so an operator notices, instead of leaking the typed
					// payload to a client that can't act on it.
					console.error("data integrity failure in sessions router", e);
					return c.json({ error: "store_failure" }, 500);
				},
			)
			// Unknown errors aren't ours to map; let Hono's default 500 take over.
			.otherwise((e) => {
				throw e;
			}),
	);

	return router;
}
