import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	AudioNotFoundResponseSchema,
	BodyTooLargeResponseSchema,
	openApiSchemaFromValibot,
	StoreFailureResponseSchema,
	UnsupportedContentTypeResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
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
import {
	AudioContentTypeSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
	MAX_AUDIO_BYTES,
	TurnIdxParamDocSchema,
	TurnIdxParamSchema,
	UploadAudioResponseSchema,
} from "./audio.types.ts";

const RAW_AUDIO_SCHEMA = { type: "string", format: "binary" } as const;

const UPLOAD_CONTENT_MAP = Object.fromEntries(
	Object.keys(CONTENT_TYPE_TO_EXTENSION).map((ct) => [ct, { schema: RAW_AUDIO_SCHEMA }]),
);
const DOWNLOAD_CONTENT_MAP = Object.fromEntries(
	Object.values(EXTENSION_TO_RESPONSE_CONTENT_TYPE).map((ct) => [ct, { schema: RAW_AUDIO_SCHEMA }]),
);

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
		describeRoute({
			tags: ["Audio"],
			summary: "Upload raw audio bytes for one turn",
			description:
				"Body is the raw audio bytes (NOT JSON, NOT multipart). Use the `Content-Type` header to declare the format — one of `audio/opus`, `audio/ogg`, `audio/webm`, `audio/mp3` / `audio/mpeg`, or `audio/wav` / `audio/x-wav`. Re-uploading the same `{sessionId, turnIdx}` with the same content-type overwrites the file.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(SessionIdSchema),
				},
				{
					in: "path",
					name: "idx",
					required: true,
					description: "Turn index (`turn.idx` from the ingest event).",
					schema: openApiSchemaFromValibot(TurnIdxParamDocSchema),
				},
			],
			requestBody: {
				required: true,
				content: UPLOAD_CONTENT_MAP,
			},
			responses: {
				"200": {
					description: "Audio stored.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(UploadAudioResponseSchema) },
					},
				},
				"400": {
					description: "Session id or turn idx failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"413": {
					description: "Audio exceeded the 50 MB cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
				"415": {
					description: "Content-Type is not a supported audio format.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(UnsupportedContentTypeResponseSchema),
						},
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

	router.get(
		"/sessions/:id/turns/:idx/audio",
		describeRoute({
			tags: ["Audio"],
			summary: "Stream stored audio bytes for one turn",
			description:
				"Streams raw bytes back with the `Content-Type` the upload declared. `Cache-Control: private, no-cache` — same URL serves a same-extension re-upload, so the client must revalidate.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(SessionIdSchema),
				},
				{
					in: "path",
					name: "idx",
					required: true,
					description: "Turn index (`turn.idx` from the ingest event).",
					schema: openApiSchemaFromValibot(TurnIdxParamDocSchema),
				},
			],
			responses: {
				"200": {
					description: "Audio bytes, in the format declared on upload.",
					content: DOWNLOAD_CONTENT_MAP,
				},
				"400": {
					description: "Session id or turn idx failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Turn has no recorded audio (or no such turn).",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(AudioNotFoundResponseSchema) },
					},
				},
			},
		}),
		async (c) => {
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
		},
	);

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
