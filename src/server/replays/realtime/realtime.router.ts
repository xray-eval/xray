import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	BodyTooLargeError,
	MalformedBodyError,
	SourceSessionNotFoundError,
} from "@/server/replays/replays.errors.ts";
import { toReplayRunResponse } from "@/server/replays/replays.service.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import { InvalidRealtimeReplayRequestError } from "./realtime.errors.ts";
import { createRealtimeReplay, runRealtimeReplay } from "./realtime.service.ts";
import { CreateRealtimeReplayRequestSchema } from "./realtime.types.ts";

/** Body is `{sourceSessionId, webhookUrl}`; same shape as the text path, same cap. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Fire-and-forget: `POST /v1/replays/realtime` returns 202 the moment the
 * row is in the store. The WS worker runs in the background on the same
 * Bun process; status flows back through `GET /v1/replays/:id` (the
 * existing text-replay endpoint — both modes share one row shape).
 */
export function createRealtimeReplaysRouter(store: Store, audioRoot: string): Hono {
	const router = new Hono();

	router.post(
		"/replays/realtime",
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
			const parsed = v.safeParse(CreateRealtimeReplayRequestSchema, raw);
			if (!parsed.success) {
				throw new InvalidRealtimeReplayRequestError(parsed.issues);
			}

			const row = createRealtimeReplay(store, parsed.output);

			// Fire-and-forget worker. Errors update the run row's `error` column;
			// log here because no caller is awaiting this promise.
			void runRealtimeReplay({ store, audioRoot, runId: row.id }).catch((err) => {
				console.error(`realtime replay ${row.id} failed`, err);
			});

			return c.json(toReplayRunResponse(row), 202);
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(
				P.union(P.instanceOf(InvalidRealtimeReplayRequestError), P.instanceOf(MalformedBodyError)),
				(e) =>
					c.json(
						{ error: "invalid_realtime_replay_request", issues: sanitizeIssues(e.issues) },
						400,
					),
			)
			.with(P.instanceOf(BodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", maxBytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(SourceSessionNotFoundError), (e) =>
				c.json({ error: "source_session_not_found", sessionId: e.sessionId }, 404),
			)
			.otherwise((e) => {
				console.error("unhandled error during realtime replay", e);
				return c.json({ error: "internal_error" }, 500);
			}),
	);

	return router;
}
