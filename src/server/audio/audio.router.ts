import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	AudioNotFoundResponseSchema,
	BodyTooLargeResponseSchema,
	openApiSchemaFromValibot,
	ReplayNotFoundResponseSchema,
	StoreFailureResponseSchema,
	UnsupportedContentTypeResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { ReplayIdSchema } from "@/server/replays/replays.types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	AudioBodyTooLargeError,
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	AudioTurnNotFoundError,
	InvalidAudioPathError,
	UnsupportedAudioContentTypeError,
} from "./audio.errors.ts";
import {
	readReplayAudio,
	readTurnAudio,
	uploadReplayAudio,
	uploadTurnAudio,
} from "./audio.service.ts";
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

export function createAudioRouter(store: Store, audioRoot: string): Hono {
	const router = new Hono();

	router.post(
		"/replays/:id/turns/:idx/audio",
		describeRoute({
			tags: ["Audio"],
			summary: "Upload raw audio bytes for one turn",
			description:
				"Body is raw audio bytes. Use the `Content-Type` header to declare the format. Re-uploading the same `{replayId, turnIdx}` with the same content-type overwrites the file; a different content-type replaces it and removes the old extension's file.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
				{
					in: "path",
					name: "idx",
					required: true,
					schema: openApiSchemaFromValibot(TurnIdxParamDocSchema),
				},
			],
			requestBody: { required: true, content: UPLOAD_CONTENT_MAP },
			responses: {
				"200": {
					description: "Audio stored.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(UploadAudioResponseSchema) },
					},
				},
				"400": {
					description: "Path failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Replay or turn not found.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayNotFoundResponseSchema) },
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
			const { replayId, turnIdx } = parseTurnPathParams(c.req.param("id"), c.req.param("idx"));
			const contentType = parseAudioContentType(c.req.header("content-type"));
			const buffer = await c.req.arrayBuffer();
			const bytes = new Uint8Array(buffer);
			const audioPath = await uploadTurnAudio(store, audioRoot, {
				replayId,
				turnIdx,
				contentType,
				bytes,
			});
			return c.json({ ok: true, audio_path: audioPath });
		},
	);

	router.get(
		"/replays/:id/turns/:idx/audio",
		describeRoute({
			tags: ["Audio"],
			summary: "Stream stored audio bytes for one turn",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
				{
					in: "path",
					name: "idx",
					required: true,
					schema: openApiSchemaFromValibot(TurnIdxParamDocSchema),
				},
			],
			responses: {
				"200": {
					description: "Audio bytes, in the format declared on upload.",
					content: DOWNLOAD_CONTENT_MAP,
				},
				"400": {
					description: "Path failed validation.",
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
			const { replayId, turnIdx } = parseTurnPathParams(c.req.param("id"), c.req.param("idx"));
			const { stream, contentLength, contentType } = await readTurnAudio(
				store,
				audioRoot,
				replayId,
				turnIdx,
			);
			return c.body(stream, 200, {
				"Content-Type": contentType,
				"Content-Length": String(contentLength),
				"Cache-Control": "private, no-cache",
			});
		},
	);

	router.post(
		"/replays/:id/audio",
		describeRoute({
			tags: ["Audio"],
			summary: "Upload the full-replay audio mixdown",
			description:
				"One file per replay. The SDK uploads this once when the run completes — the inspector plays it back with per-turn segments derived from `replay_turns` timestamps.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
			],
			requestBody: { required: true, content: UPLOAD_CONTENT_MAP },
			responses: {
				"200": {
					description: "Mixdown stored.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(UploadAudioResponseSchema) },
					},
				},
				"400": {
					description: "Path failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Replay not found.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayNotFoundResponseSchema) },
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
			},
		}),
		bodyLimit({
			maxSize: MAX_AUDIO_BYTES,
			onError: () => {
				throw new AudioBodyTooLargeError(MAX_AUDIO_BYTES);
			},
		}),
		async (c) => {
			const replayId = parseReplayIdParam(c.req.param("id"));
			const contentType = parseAudioContentType(c.req.header("content-type"));
			const buffer = await c.req.arrayBuffer();
			const bytes = new Uint8Array(buffer);
			const audioPath = await uploadReplayAudio(store, audioRoot, {
				replayId,
				contentType,
				bytes,
			});
			return c.json({ ok: true, audio_path: audioPath });
		},
	);

	router.get(
		"/replays/:id/audio",
		describeRoute({
			tags: ["Audio"],
			summary: "Stream the full-replay audio mixdown",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
			],
			responses: {
				"200": {
					description: "Audio bytes, in the format declared on upload.",
					content: DOWNLOAD_CONTENT_MAP,
				},
				"400": {
					description: "Path failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Replay has no recorded audio (or no such replay).",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(AudioNotFoundResponseSchema) },
					},
				},
			},
		}),
		async (c) => {
			const replayId = parseReplayIdParam(c.req.param("id"));
			const { stream, contentLength, contentType } = await readReplayAudio(
				store,
				audioRoot,
				replayId,
			);
			return c.body(stream, 200, {
				"Content-Type": contentType,
				"Content-Length": String(contentLength),
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
				c.json({ error: "unsupported_content_type", content_type: e.contentType }, 415),
			)
			.with(P.instanceOf(AudioBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", max_bytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(AudioReplayNotFoundError), (e) =>
				c.json({ error: "replay_not_found", replay_id: e.replayId }, 404),
			)
			.with(
				P.union(P.instanceOf(AudioTurnNotFoundError), P.instanceOf(AudioNotUploadedError)),
				(e) =>
					c.json(
						e.turnIdx === null
							? { error: "audio_not_found", replay_id: e.replayId }
							: { error: "audio_not_found", replay_id: e.replayId, turn_idx: e.turnIdx },
						404,
					),
			)
			.with(P.instanceOf(AudioPathOutsideRootError), (e) => {
				console.error("audio path resolved outside root", e);
				return c.json({ error: "store_failure" }, 500);
			})
			.with(P.instanceOf(Error), (e) => {
				console.error("unhandled error during audio request", e);
				return c.json({ error: "store_failure" }, 500);
			})
			.otherwise((e) => {
				throw e;
			}),
	);

	return router;
}

function parseTurnPathParams(
	rawReplayId: string,
	rawTurnIdx: string,
): { replayId: string; turnIdx: number } {
	const idCheck = v.safeParse(ReplayIdSchema, rawReplayId);
	if (!idCheck.success) throw new InvalidAudioPathError(idCheck.issues);
	const idxCheck = v.safeParse(TurnIdxParamSchema, rawTurnIdx);
	if (!idxCheck.success) throw new InvalidAudioPathError(idxCheck.issues);
	return { replayId: idCheck.output, turnIdx: idxCheck.output };
}

function parseReplayIdParam(raw: string): string {
	const idCheck = v.safeParse(ReplayIdSchema, raw);
	if (!idCheck.success) throw new InvalidAudioPathError(idCheck.issues);
	return idCheck.output;
}

function parseAudioContentType(header: string | undefined): AudioContentType {
	const stripped = header?.split(";")[0]?.trim().toLowerCase() ?? null;
	const result = v.safeParse(AudioContentTypeSchema, stripped);
	if (!result.success) throw new UnsupportedAudioContentTypeError(stripped);
	return result.output;
}
