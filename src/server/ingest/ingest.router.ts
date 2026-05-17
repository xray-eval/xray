import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	BodyTooLargeResponseSchema,
	OkResponseSchema,
	openApiSchemaFromValibot,
	StoreFailureResponseSchema,
	UnknownTurnResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	BodyTooLargeError,
	InvalidEventError,
	MalformedBodyError,
	UnknownTurnError,
} from "./ingest.errors.ts";
import { applyEvent } from "./ingest.service.ts";
import { IngestEventSchema, SessionIdSchema } from "./ingest.types.ts";

/**
 * Body byte cap. One megabyte is generous for a single voice-agent event
 * (transcripts run at ~10K chars per turn under normal load); going much
 * higher costs heap and reflection-amplification risk.
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * HTTP ingest router. Mounted at `/v1`; final URL is
 * `POST /v1/sessions/:id/events`.
 *
 * **No authentication.** The default bind is `127.0.0.1` so single-host
 * self-hosting is safe-by-default; widening to `0.0.0.0` is the operator's
 * opt-in (set `HOST=0.0.0.0` AND front with an auth-checking reverse proxy).
 *
 * Idempotency: replaying any event with the same identity key
 * (`session_id` + `idx` for turns and tool calls; `session_id` for
 * session_started / session_ended) is a no-op. Idempotency lives in
 * `ingest.service.ts`; this file is HTTP plumbing only.
 */
export function createIngestRouter(store: Store): Hono {
	const router = new Hono();

	router.post(
		"/sessions/:id/events",
		describeRoute({
			tags: ["Ingest"],
			summary: "POST a voice-agent event into a session",
			description:
				"Append one event (`session_started`, `turn_completed`, `tool_called`, `session_ended`) to a session. Idempotent on `session_id` + `idx` — retrying a delivered event is a no-op. The session id is part of the URL so the body never has to carry it.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					description: "Session id chosen by the caller.",
					schema: openApiSchemaFromValibot(SessionIdSchema),
				},
			],
			requestBody: {
				required: true,
				content: { "application/json": { schema: openApiSchemaFromValibot(IngestEventSchema) } },
			},
			responses: {
				"200": {
					description: "Event accepted.",
					content: { "application/json": { schema: openApiSchemaFromValibot(OkResponseSchema) } },
				},
				"400": {
					description: "Session id or body failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"413": {
					description: "Body exceeded the 1 MB cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
				"422": {
					description: "`tool_called` referenced a turn idx with no row.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(UnknownTurnResponseSchema) },
					},
				},
				"500": {
					description: "Unhandled store-side failure.",
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
			const rawSessionId = c.req.param("id");

			const idCheck = v.safeParse(SessionIdSchema, rawSessionId);
			if (!idCheck.success) {
				throw new InvalidEventError(rawSessionId, idCheck.issues);
			}
			const sessionId = idCheck.output;

			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedBodyError(sessionId, { cause });
			}

			const parsed = v.safeParse(IngestEventSchema, raw);
			if (!parsed.success) {
				throw new InvalidEventError(sessionId, parsed.issues);
			}

			applyEvent(store, sessionId, parsed.output);
			return c.json({ ok: true });
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(P.union(P.instanceOf(InvalidEventError), P.instanceOf(MalformedBodyError)), (e) =>
				c.json({ error: "invalid_event", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(UnknownTurnError), (e) =>
				c.json({ error: "unknown_turn", sessionId: e.sessionId, turnIdx: e.turnIdx }, 422),
			)
			.with(P.instanceOf(BodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", maxBytes: e.maxBytes }, 413),
			)
			.otherwise((e) => {
				console.error("unhandled error during ingest", e);
				return c.json({ error: "store_failure" }, 500);
			}),
	);

	return router;
}
