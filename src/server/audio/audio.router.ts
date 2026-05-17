import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import { SessionIdSchema } from "@/server/ingest/ingest.types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	AudioBodyTooLargeError,
	AudioNotUploadedError,
	AudioTurnNotFoundError,
	InvalidAudioPathError,
	UnsupportedAudioContentTypeError,
} from "./audio.errors.ts";
import { readTurnAudio, uploadTurnAudio } from "./audio.service.ts";
import type { AudioContentType } from "./audio.types.ts";
import { AudioContentTypeSchema, MAX_AUDIO_BYTES, TurnIdxParamSchema } from "./audio.types.ts";

/**
 * `POST /v1/sessions/:id/turns/:idx/audio` — upload raw bytes.
 * `GET  /v1/sessions/:id/turns/:idx/audio` — stream them back.
 *
 * No transcoding. Audio lives on the mounted volume next to `xray.db`
 * per `single-image-distribution.md`.
 */
export function createAudioRouter(store: Store, audioRoot: string): Hono {
	const router = new Hono();

	router.post(
		"/sessions/:id/turns/:idx/audio",
		bodyLimit({
			maxSize: MAX_AUDIO_BYTES,
			onError: () => {
				throw new AudioBodyTooLargeError(MAX_AUDIO_BYTES);
			},
		}),
		async (c) => {
			const { sessionId, turnIdx } = parsePathParams(c.req.param("id"), c.req.param("idx"));
			const contentType = parseAudioContentType(c.req.header("content-type"));

			const buffer = await c.req.arrayBuffer();
			const bytes = new Uint8Array(buffer);

			const audioPath = await uploadTurnAudio(store, audioRoot, {
				sessionId,
				turnIdx,
				contentType,
				bytes,
			});
			return c.json({ ok: true, audioPath });
		},
	);

	router.get("/sessions/:id/turns/:idx/audio", async (c) => {
		const { sessionId, turnIdx } = parsePathParams(c.req.param("id"), c.req.param("idx"));
		const { stream, contentLength, contentType } = await readTurnAudio(
			store,
			audioRoot,
			sessionId,
			turnIdx,
		);
		return c.body(stream, 200, {
			"Content-Type": contentType,
			"Content-Length": String(contentLength),
			// `no-cache` (revalidate, not no-store): a same-extension re-upload
			// keeps the same URL, so a long max-age would serve stale bytes.
			"Cache-Control": "private, no-cache",
		});
	});

	router.onError((err, c) =>
		match(err)
			.with(P.instanceOf(InvalidAudioPathError), (e) =>
				c.json({ error: "invalid_audio_path", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(UnsupportedAudioContentTypeError), (e) =>
				c.json({ error: "unsupported_content_type", contentType: e.contentType }, 415),
			)
			.with(P.instanceOf(AudioBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", maxBytes: e.maxBytes }, 413),
			)
			.with(
				P.union(P.instanceOf(AudioTurnNotFoundError), P.instanceOf(AudioNotUploadedError)),
				(e) =>
					c.json({ error: "audio_not_found", sessionId: e.sessionId, turnIdx: e.turnIdx }, 404),
			)
			.otherwise((e) => {
				console.error("unhandled error during audio request", e);
				return c.json({ error: "store_failure" }, 500);
			}),
	);

	return router;
}

function parsePathParams(
	rawSessionId: string,
	rawTurnIdx: string,
): { sessionId: string; turnIdx: number } {
	const idCheck = v.safeParse(SessionIdSchema, rawSessionId);
	if (!idCheck.success) {
		throw new InvalidAudioPathError(idCheck.issues);
	}
	const idxCheck = v.safeParse(TurnIdxParamSchema, rawTurnIdx);
	if (!idxCheck.success) {
		throw new InvalidAudioPathError(idxCheck.issues);
	}
	return { sessionId: idCheck.output, turnIdx: idxCheck.output };
}

function parseAudioContentType(header: string | undefined): AudioContentType {
	// Strip `; codecs=...` — browsers attach those routinely on audio/webm.
	const stripped = header?.split(";")[0]?.trim().toLowerCase() ?? null;
	const result = v.safeParse(AudioContentTypeSchema, stripped);
	if (!result.success) {
		throw new UnsupportedAudioContentTypeError(stripped);
	}
	return result.output;
}
