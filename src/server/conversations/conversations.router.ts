import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	BodyTooLargeResponseSchema,
	ConversationConflictResponseSchema,
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
	InvalidConversationIdError,
	InvalidConversationRequestError,
	MalformedConversationBodyError,
	VersionFingerprintMismatchError,
} from "./conversations.errors.ts";
import {
	getConversationVersion,
	getLatestConversation,
	listConversations,
	toConversationResponse,
	upsertConversation,
} from "./conversations.service.ts";
import {
	ConversationIdSchema,
	ConversationResponseSchema,
	ConversationSpecSchema,
	ConversationVersionSchema,
	ListConversationsResponseSchema,
	MAX_CONVERSATION_BODY_BYTES,
} from "./conversations.types.ts";

export function createConversationsRouter(store: Store): Hono {
	const router = new Hono();

	router.post(
		"/conversations",
		describeRoute({
			tags: ["Conversations"],
			summary: "Upsert a Conversation",
			description:
				"Idempotent upsert keyed by `(id, version)`. The SDK auto-computes `version` as a fingerprint over the turn structure — re-POSTing the same `(id, version)` with a different turn structure returns 409 (the dev forgot to bump version after editing the spec).",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: openApiSchemaFromValibot(ConversationSpecSchema) },
				},
			},
			responses: {
				"200": {
					description: "Conversation upserted (or already existed unchanged).",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ConversationResponseSchema) },
					},
				},
				"400": {
					description: "Body failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"409": {
					description: "(id, version) exists with a different turn structure.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ConversationConflictResponseSchema),
						},
					},
				},
				"413": {
					description: "Body exceeded the per-route byte cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
			},
		}),
		bodyLimit({
			maxSize: MAX_CONVERSATION_BODY_BYTES,
			onError: () => {
				throw new ConversationBodyTooLargeError(MAX_CONVERSATION_BODY_BYTES);
			},
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedConversationBodyError({ cause });
			}
			const parsed = v.safeParse(ConversationSpecSchema, raw);
			if (!parsed.success) {
				throw new InvalidConversationRequestError(parsed.issues);
			}
			const row = upsertConversation(store, parsed.output);
			return c.json(toConversationResponse(row));
		},
	);

	router.get(
		"/conversations",
		describeRoute({
			tags: ["Conversations"],
			summary: "List all conversations (one row per id)",
			description:
				"Returns one row per distinct conversation id, with the latest version, replay count, and version count.",
			responses: {
				"200": {
					description: "All conversations, newest-first.",
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
		"/conversations/:id",
		describeRoute({
			tags: ["Conversations"],
			summary: "Get the latest version of a conversation",
			description:
				"Returns the most recently created version's row. Use `?version=…` to pick a specific version.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ConversationIdSchema),
				},
				{
					in: "query",
					name: "version",
					required: false,
					schema: openApiSchemaFromValibot(ConversationVersionSchema),
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
					description: "Id or version failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Conversation (or version) not found.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ConversationNotFoundResponseSchema),
						},
					},
				},
			},
		}),
		(c) => {
			const id = parseConversationId(c.req.param("id"));
			const rawVersion = c.req.query("version");
			if (rawVersion === undefined) {
				const row = getLatestConversation(store, id);
				if (row === undefined) throw new ConversationNotFoundError(id);
				return c.json(toConversationResponse(row));
			}
			const versionCheck = v.safeParse(ConversationVersionSchema, rawVersion);
			if (!versionCheck.success) {
				throw new InvalidConversationRequestError(versionCheck.issues);
			}
			const row = getConversationVersion(store, id, versionCheck.output);
			if (row === undefined) throw new ConversationNotFoundError(id, versionCheck.output);
			return c.json(toConversationResponse(row));
		},
	);

	router.get(
		"/conversations/:id/replays",
		describeRoute({
			tags: ["Conversations"],
			summary: "List replays for a conversation",
			description: "Lists every Replay across every version of this Conversation, newest first.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ConversationIdSchema),
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
					description: "Conversation id failed validation.",
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
			const id = parseConversationId(c.req.param("id"));
			if (getLatestConversation(store, id) === undefined) {
				throw new ConversationNotFoundError(id);
			}
			return c.json({ items: listReplaysForConversation(store, id) });
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(
				P.union(
					P.instanceOf(InvalidConversationRequestError),
					P.instanceOf(MalformedConversationBodyError),
				),
				(e) =>
					c.json({ error: "invalid_conversation_request", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(ConversationBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", max_bytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(InvalidConversationIdError), (e) =>
				c.json({ error: "invalid_conversation_id", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(VersionFingerprintMismatchError), (e) =>
				c.json(
					{
						error: "version_fingerprint_mismatch",
						conversation_id: e.conversationId,
						conversation_version: e.conversationVersion,
					},
					409,
				),
			)
			.with(P.instanceOf(ConversationNotFoundError), (e) =>
				c.json(
					{
						error: "conversation_not_found",
						conversation_id: e.conversationId,
						...(e.conversationVersion === null
							? {}
							: { conversation_version: e.conversationVersion }),
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

function parseConversationId(raw: string): string {
	const idCheck = v.safeParse(ConversationIdSchema, raw);
	if (!idCheck.success) throw new InvalidConversationIdError(idCheck.issues);
	return idCheck.output;
}
