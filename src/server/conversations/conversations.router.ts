import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import { saveRecordedConversationAudio } from "@/server/audio/audio.service.ts";
import { MAX_AUDIO_BYTES } from "@/server/audio/audio.types.ts";
import {
	BodyTooLargeResponseSchema,
	ConversationNotFoundResponseSchema,
	openApiSchemaFromValibot,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { listReplaysForConversation } from "@/server/replays/replays.service.ts";
import { ListReplaysResponseSchema } from "@/server/replays/replays.types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	ConversationBodyTooLargeError,
	ConversationNotFoundError,
	InvalidConversationHashError,
	InvalidConversationRequestError,
	MalformedConversationBodyError,
	MissingSpecPartError,
	RecordedAudioUploadKeyError,
} from "./conversations.errors.ts";
import {
	canonicalizeAndHashTurns,
	ensureConversation,
	getConversationByHash,
	listConversations,
	materializeRequestTurns,
	toConversationResponse,
} from "./conversations.service.ts";
import {
	ConversationHashSchema,
	ConversationResponseSchema,
	CreateConversationRequestSchema,
	ListConversationsResponseSchema,
	MAX_CONVERSATION_BODY_BYTES,
} from "./conversations.types.ts";

const MAX_CONVERSATION_MULTIPART_BYTES = 512 * 1024 * 1024;

export function createConversationsRouter(store: Store, audioRoot: string): Hono {
	const router = new Hono();

	router.post(
		"/conversations",
		describeRoute({
			tags: ["Conversations"],
			summary: "Upsert a Conversation",
			description:
				"Multipart/form-data: a `spec` JSON part with `name` + `turns`, and one named file part per `RecordedAudio` turn. The server reads each audio part, sha256s the bytes, stores a content-addressed copy, computes the conversation hash from the canonical turn JSON (with sha256 substituted in), and upserts the conversation row by hash (last-write-wins on `name`). Returns the canonical row.",
			requestBody: {
				required: true,
				content: {
					"multipart/form-data": {
						schema: {
							type: "object",
							required: ["spec"],
							properties: {
								spec: openApiSchemaFromValibot(CreateConversationRequestSchema),
							},
							additionalProperties: { type: "string", format: "binary" },
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Conversation upserted; canonical row returned.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ConversationResponseSchema) },
					},
				},
				"400": {
					description: "Body failed validation or referenced upload_key is missing.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"413": {
					description: "Body exceeded byte cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
			},
		}),
		bodyLimit({
			maxSize: MAX_CONVERSATION_MULTIPART_BYTES,
			onError: () => {
				throw new ConversationBodyTooLargeError(MAX_CONVERSATION_MULTIPART_BYTES);
			},
		}),
		async (c) => {
			let body: Record<string, string | File>;
			try {
				body = await c.req.parseBody({ all: false });
			} catch (cause) {
				throw new MalformedConversationBodyError({ cause });
			}
			const { spec, audioBytesByKey } = await parseMultipartConversationBody(body);
			const parsed = v.safeParse(CreateConversationRequestSchema, spec);
			if (!parsed.success) throw new InvalidConversationRequestError(parsed.issues);
			const { canonicalTurns, audioWrites } = await materializeRequestTurns(
				parsed.output.turns,
				audioBytesByKey,
			);
			const { json: turnsJson, hash } = await canonicalizeAndHashTurns(canonicalTurns);

			// Write audio files BEFORE the upsert. Content-addressed
			// (`recorded/<sha256>.wav`) — a partial write followed by a failed
			// upsert leaves a harmless orphan file the next POST will find.
			await Promise.all(
				audioWrites.map(({ sha256, bytes }) =>
					saveRecordedConversationAudio(audioRoot, sha256, bytes),
				),
			);

			const now = new Date().toISOString();
			const row = ensureConversation(store.db, {
				hash,
				name: parsed.output.name,
				turnsJson,
				now,
			});
			return c.json(toConversationResponse(row));
		},
	);

	router.get(
		"/conversations",
		describeRoute({
			tags: ["Conversations"],
			summary: "List all conversations",
			description:
				"Returns one row per content hash with name, replay count, and last-run timestamp. Sorted by most-recent activity.",
			responses: {
				"200": {
					description: "All conversations, newest-active first.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ListConversationsResponseSchema),
						},
					},
				},
			},
		}),
		(c) => {
			return c.json({ items: listConversations(store) });
		},
	);

	router.get(
		"/conversations/:hash",
		describeRoute({
			tags: ["Conversations"],
			summary: "Get a conversation by content hash",
			parameters: [
				{
					in: "path",
					name: "hash",
					required: true,
					schema: openApiSchemaFromValibot(ConversationHashSchema),
				},
			],
			responses: {
				"200": {
					description: "Conversation row.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ConversationResponseSchema) },
					},
				},
				"400": {
					description: "Hash failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Conversation not found.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ConversationNotFoundResponseSchema),
						},
					},
				},
			},
		}),
		(c) => {
			const hash = parseConversationHash(c.req.param("hash"));
			const row = getConversationByHash(store, hash);
			if (row === undefined) throw new ConversationNotFoundError(hash);
			return c.json(toConversationResponse(row));
		},
	);

	router.get(
		"/conversations/:hash/replays",
		describeRoute({
			tags: ["Conversations"],
			summary: "List replays for a conversation",
			description: "Lists every Replay attached to the given conversation hash, newest first.",
			parameters: [
				{
					in: "path",
					name: "hash",
					required: true,
					schema: openApiSchemaFromValibot(ConversationHashSchema),
				},
			],
			responses: {
				"200": {
					description: "Replays for the conversation (possibly empty).",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ListReplaysResponseSchema),
						},
					},
				},
				"400": {
					description: "Conversation hash failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Conversation not found.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ConversationNotFoundResponseSchema),
						},
					},
				},
			},
		}),
		(c) => {
			const hash = parseConversationHash(c.req.param("hash"));
			if (getConversationByHash(store, hash) === undefined) {
				throw new ConversationNotFoundError(hash);
			}
			return c.json({ items: listReplaysForConversation(store, hash) });
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(P.instanceOf(InvalidConversationHashError), (e) =>
				c.json({ error: "invalid_conversation_hash", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(
				P.union(
					P.instanceOf(InvalidConversationRequestError),
					P.instanceOf(MalformedConversationBodyError),
				),
				(e) =>
					c.json({ error: "invalid_conversation_request", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(RecordedAudioUploadKeyError), (e) =>
				c.json(
					{
						error: match(e.reason)
							.with("missing", () => "recorded_audio_upload_key_missing" as const)
							.with("unreferenced", () => "recorded_audio_upload_key_unreferenced" as const)
							.exhaustive(),
						upload_key: e.uploadKey,
					},
					400,
				),
			)
			.with(P.instanceOf(ConversationBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", max_bytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(ConversationNotFoundError), (e) =>
				c.json(
					{
						error: "conversation_not_found",
						conversation_hash: e.conversationHash,
					},
					404,
				),
			)
			.with(P.instanceOf(Error), (e) => {
				console.error("unhandled error during conversation request", e);
				return c.json({ error: "internal_error" }, 500);
			})
			.otherwise((e) => {
				throw e;
			}),
	);

	return router;
}

function parseConversationHash(raw: string): string {
	const check = v.safeParse(ConversationHashSchema, raw);
	if (!check.success) throw new InvalidConversationHashError(check.issues);
	return check.output;
}

async function parseMultipartConversationBody(
	body: Record<string, string | File>,
): Promise<{ spec: unknown; audioBytesByKey: Map<string, Uint8Array<ArrayBuffer>> }> {
	let specEntry: string | undefined;
	const audioBytesByKey = new Map<string, Uint8Array<ArrayBuffer>>();
	for (const [key, value] of Object.entries(body)) {
		if (key === "spec") {
			if (typeof value === "string") specEntry = value;
			continue;
		}
		if (typeof value === "string") continue;
		if (value.size > MAX_AUDIO_BYTES) {
			throw new ConversationBodyTooLargeError(MAX_AUDIO_BYTES);
		}
		audioBytesByKey.set(key, new Uint8Array(await value.arrayBuffer()));
	}
	if (specEntry === undefined) throw new MissingSpecPartError();
	if (Buffer.byteLength(specEntry, "utf8") > MAX_CONVERSATION_BODY_BYTES) {
		throw new ConversationBodyTooLargeError(MAX_CONVERSATION_BODY_BYTES);
	}
	try {
		return { spec: JSON.parse(specEntry), audioBytesByKey };
	} catch (cause) {
		throw new MalformedConversationBodyError({ cause });
	}
}
