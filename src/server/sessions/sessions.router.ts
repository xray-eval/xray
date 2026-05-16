import { Hono } from "hono";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import { InvalidQueryError } from "./sessions.errors.ts";
import { ListSessionsQuerySchema } from "./sessions.query.ts";
import { listSessionsForApi } from "./sessions.service.ts";

/**
 * Sessions router. Mounted at `/v1`; final URL is `GET /v1/sessions`.
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

	router.onError((err, c) =>
		match(err)
			.with(P.instanceOf(InvalidQueryError), (e) =>
				c.json({ error: "invalid_query", issues: sanitizeIssues(e.issues) }, 400),
			)
			.otherwise((e) => {
				console.error("unhandled error in sessions router", e);
				return c.json({ error: "store_failure" }, 500);
			}),
	);

	return router;
}
