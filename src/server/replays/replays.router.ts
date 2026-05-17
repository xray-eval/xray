import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import { getReplayRun } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";

import {
	BodyTooLargeError,
	InvalidReplayIdError,
	InvalidReplayRequestError,
	MalformedBodyError,
	ReplayRunNotFoundError,
	SourceSessionNotFoundError,
} from "./replays.errors.ts";
import { createReplay, runReplay, toReplayRunResponse } from "./replays.service.ts";
import { CreateReplayRequestSchema } from "./replays.types.ts";

/** Body is just `{sourceSessionId, webhookUrl}`; even with a 2KB URL the worst case fits well under 4KB. */
const MAX_BODY_BYTES = 4 * 1024;

const ReplayIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-fA-F-]{36}$/, "Must be a UUID"));

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

	router.get("/replays/:id", (c) => {
		const idCheck = v.safeParse(ReplayIdSchema, c.req.param("id"));
		if (!idCheck.success) {
			throw new InvalidReplayIdError(idCheck.issues);
		}
		const row = getReplayRun(store.db, idCheck.output);
		if (row === undefined) {
			throw new ReplayRunNotFoundError(idCheck.output);
		}
		return c.json(toReplayRunResponse(row));
	});

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
			.with(P.instanceOf(SourceSessionNotFoundError), (e) =>
				c.json({ error: "source_session_not_found", sessionId: e.sessionId }, 404),
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
