import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { BaseIssue } from "valibot";
import * as v from "valibot";

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

	router.onError((err, c) => {
		if (err instanceof InvalidEventError || err instanceof MalformedBodyError) {
			return c.json({ error: "invalid_event", issues: sanitizeIssues(err.issues) }, 400);
		}
		if (err instanceof UnknownTurnError) {
			return c.json({ error: "unknown_turn", sessionId: err.sessionId, turnIdx: err.turnIdx }, 422);
		}
		if (err instanceof BodyTooLargeError) {
			return c.json({ error: "body_too_large", maxBytes: err.maxBytes }, 413);
		}
		console.error("store error during ingest", err);
		return c.json({ error: "store_failure" }, 500);
	});

	return router;
}

/**
 * Echo Valibot issues back to the caller without any caller-supplied values
 * (`input`/`value` at the issue level, plus `input`/`value` on every `path`
 * step — Valibot puts the offending field's value AND the entire parent
 * object on the path step). Without this, a 1MB request body fails schema
 * validation and the 400 response reflects ~1MB of caller content back.
 *
 * The schema-meaningful fields (`kind`, `type`, `expected`, `received`,
 * `message`, plus the path's structural breadcrumbs `type`/`origin`/`key`)
 * survive so a client can still pin-point which field failed.
 */
function sanitizeIssues(issues: readonly BaseIssue<unknown>[]) {
	return issues.map((issue) => ({
		kind: issue.kind,
		type: issue.type,
		expected: issue.expected,
		received: issue.received,
		message: issue.message,
		path: issue.path?.map((step) => ({
			type: step.type,
			origin: step.origin,
			key: step.key,
		})),
	}));
}
