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
	InvalidAudioExtensionError,
	InvalidAudioPathError,
	ReplayUploadStateError,
	UnsupportedAudioContentTypeError,
} from "./audio.errors.ts";
import { readReplayAudio, uploadReplayAudio } from "./audio.service.ts";
import type { AudioContentType } from "./audio.types.ts";
import {
	AudioContentTypeSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
	MAX_AUDIO_BYTES,
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
		"/replays/:id/audio",
		describeRoute({
			tags: ["Audio"],
			summary: "Upload the full-replay stereo audio",
			description:
				"Body is raw audio bytes (typically a 48kHz int16 stereo WAV with left=user, right=agent, written by the driver's wall-clock capture). Server-side VAD on the uploaded file produces `replay_turns` and `speech_segments` rows.",
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
					description: "Replay not found.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayNotFoundResponseSchema) },
					},
				},
				"409": {
					description:
						"Replay's lifecycle_state is not one of `pending` / `running` / `recording_uploaded` (the only states in which a fresh audio upload is safe). Caller must wait for analysis to finish or accept the current replay as final.",
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
			summary: "Stream the full-replay stereo audio",
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
			.with(P.instanceOf(AudioNotUploadedError), (e) =>
				c.json({ error: "audio_not_found", replay_id: e.replayId }, 404),
			)
			.with(P.instanceOf(ReplayUploadStateError), (e) =>
				c.json(
					{
						error: "replay_upload_state_invalid",
						replay_id: e.replayId,
						current_state: e.currentState,
					},
					409,
				),
			)
			.with(P.instanceOf(AudioPathOutsideRootError), (e) => {
				console.error("audio path resolved outside root", e);
				return c.json({ error: "store_failure" }, 500);
			})
			.with(P.instanceOf(InvalidAudioExtensionError), (e) => {
				console.error("stored audio path has unsupported extension", e);
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
