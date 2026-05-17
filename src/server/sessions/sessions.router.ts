import { Hono } from "hono";
import { match, P } from "ts-pattern";
import * as v from "valibot";

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

	router.get("/sessions", (c) => {
		const parsed = v.safeParse(ListSessionsQuerySchema, c.req.query());
		if (!parsed.success) {
			throw new InvalidQueryError(parsed.issues);
		}
		return c.json(listSessionsForApi(store, parsed.output));
	});

	router.get("/sessions/:id", (c) => {
		// Shared with ingest so any id we accept on write is legal on read.
		const idCheck = v.safeParse(SessionIdSchema, c.req.param("id"));
		if (!idCheck.success) {
			throw new InvalidSessionIdError(idCheck.issues);
		}
		return c.json(getConversationForApi(store, idCheck.output));
	});

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
