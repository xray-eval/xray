import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import { ConversationNotFoundError } from "@/server/conversations/conversations.errors.ts";
import {
	BodyTooLargeResponseSchema,
	ConversationNotFoundResponseSchema,
	openApiSchemaFromValibot,
	ReplayNotFoundResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import type { JobRunner } from "@/server/jobs/jobs.bunqueue.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	InvalidCompareSelectionError,
	InvalidReplayIdError,
	InvalidReplayRequestError,
	MalformedReplayBodyError,
	ReplayBodyTooLargeError,
	ReplayLifecycleTransitionError,
	ReplayNotFoundError,
	ReplayNotReadyForAnalysisError,
} from "./replays.errors.ts";
import type { ReplayEvents } from "./replays.events.ts";
import {
	compareReplays,
	createReplay,
	enqueueAnalysis,
	findReplay,
	getReplay,
	updateReplay,
} from "./replays.service.ts";
import {
	AnalyzeReplayResponseSchema,
	COMPARE_MAX,
	COMPARE_MIN,
	CompareReplaysRequestSchema,
	CompareReplaysResponseSchema,
	CreateReplayRequestSchema,
	ReplayDetailResponseSchema,
	ReplayIdSchema,
	UpdateReplayRequestSchema,
} from "./replays.types.ts";

const MAX_REPLAY_BODY_BYTES = 64 * 1024;
const MAX_COMPARE_BODY_BYTES = 16 * 1024;

export function createReplaysRouter(
	store: Store,
	jobRunner: JobRunner,
	events: ReplayEvents,
): Hono {
	const router = new Hono();

	router.post(
		"/replays",
		describeRoute({
			tags: ["Replays"],
			summary: "Start a Replay",
			description:
				"Creates the Replay row eagerly so the SDK can propagate `xray.replay.id` as OTEL baggage on the LiveKit room metadata BEFORE the dev's agent emits its first span. Returns the full detail row with `lifecycle_state='pending'`.",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: openApiSchemaFromValibot(CreateReplayRequestSchema) },
				},
			},
			responses: {
				"201": {
					description: "Replay row created; lifecycle_state='pending'.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ReplayDetailResponseSchema),
						},
					},
				},
				"400": {
					description: "Body failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "`conversation_hash` not found — POST /v1/conversations first.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ConversationNotFoundResponseSchema),
						},
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
			maxSize: MAX_REPLAY_BODY_BYTES,
			onError: () => {
				throw new ReplayBodyTooLargeError(MAX_REPLAY_BODY_BYTES);
			},
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedReplayBodyError({ cause });
			}
			const parsed = v.safeParse(CreateReplayRequestSchema, raw);
			if (!parsed.success) throw new InvalidReplayRequestError(parsed.issues);
			const detail = createReplay(store, parsed.output);
			return c.json(detail, 201);
		},
	);

	router.patch(
		"/replays/:id",
		describeRoute({
			tags: ["Replays"],
			summary: "Update a Replay",
			description:
				"Applies a partial update. Used by the SDK during a run to set `lifecycle_state`, `finished_at`, and `failure_reason`.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
			],
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: openApiSchemaFromValibot(UpdateReplayRequestSchema) },
				},
			},
			responses: {
				"200": {
					description: "Updated row.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ReplayDetailResponseSchema),
						},
					},
				},
				"400": {
					description: "Body or id failed validation.",
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
					description: "Body exceeded byte cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
			},
		}),
		bodyLimit({
			maxSize: MAX_REPLAY_BODY_BYTES,
			onError: () => {
				throw new ReplayBodyTooLargeError(MAX_REPLAY_BODY_BYTES);
			},
		}),
		async (c) => {
			const id = parseReplayId(c.req.param("id"));
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedReplayBodyError({ cause });
			}
			const parsed = v.safeParse(UpdateReplayRequestSchema, raw);
			if (!parsed.success) throw new InvalidReplayRequestError(parsed.issues);
			return c.json(updateReplay(store, id, parsed.output));
		},
	);

	router.get(
		"/replays/:id",
		describeRoute({
			tags: ["Replays"],
			summary: "Get a Replay's full detail",
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
					description: "Replay detail.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ReplayDetailResponseSchema),
						},
					},
				},
				"400": {
					description: "Id failed validation.",
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
			},
		}),
		(c) => {
			const id = parseReplayId(c.req.param("id"));
			return c.json(getReplay(store, id));
		},
	);

	router.post(
		"/replays/:id/analyze",
		describeRoute({
			tags: ["Replays"],
			summary: "Kick off server-side analysis",
			description:
				"Enqueues the bunqueue `analyze-replay` job. Requires `lifecycle_state='recording_uploaded'` (set automatically when POST /replays/:id/audio succeeds). Flips the row to `lifecycle_state='analyzing'` with `analysis_step='vad'`.",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					schema: openApiSchemaFromValibot(ReplayIdSchema),
				},
			],
			responses: {
				"202": {
					description: "Job enqueued.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(AnalyzeReplayResponseSchema),
						},
					},
				},
				"400": {
					description: "Id failed validation.",
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
						"Replay is not in `recording_uploaded`. Upload the audio first or wait for an in-flight job to finish.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
			},
		}),
		async (c) => {
			const id = parseReplayId(c.req.param("id"));
			const result = await enqueueAnalysis(store, jobRunner, events, id);
			return c.json({ job_id: result.jobId, lifecycle_state: result.lifecycleState }, 202);
		},
	);

	router.get(
		"/replays/:id/events",
		describeRoute({
			tags: ["Replays"],
			summary: "Server-sent events for analysis progress",
			description:
				"Streams `state`, `progress`, `completed`, and `failed` SSE events for one replay. The handler sends an initial `state` event with the current lifecycle, then forwards every transition until the replay reaches a terminal state. A `: heartbeat\\n\\n` line lands every 15s to keep proxies from idling out the connection.",
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
					description: "SSE event stream.",
					content: { "text/event-stream": { schema: { type: "string" } } },
				},
				"400": {
					description: "Id failed validation.",
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
			},
		}),
		async (c) => {
			const id = parseReplayId(c.req.param("id"));
			const replay = findReplay(store, id);
			if (replay === undefined) throw new ReplayNotFoundError(id);
			return streamSSE(c, async (stream) => {
				let heartbeat: ReturnType<typeof setInterval> | undefined;

				const cleanup = () => {
					if (heartbeat !== undefined) {
						clearInterval(heartbeat);
						heartbeat = undefined;
					}
				};

				const done = Promise.withResolvers<void>();
				const unsubscribe = events.subscribe(id, (event) => {
					void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).then(() => {
						if (event.type === "completed" || event.type === "failed") {
							done.resolve();
						}
					});
				});

				stream.onAbort(() => {
					done.resolve();
				});

				const initialState: {
					type: "state";
					lifecycle_state: string;
					analysis_step: string | null;
				} = {
					type: "state",
					lifecycle_state: replay.lifecycleState,
					analysis_step: replay.analysisStep,
				};
				await stream.writeSSE({ event: "state", data: JSON.stringify(initialState) });

				if (replay.lifecycleState === "completed" || replay.lifecycleState === "failed") {
					cleanup();
					unsubscribe();
					return;
				}

				heartbeat = setInterval(() => {
					void stream.write(": heartbeat\n\n");
				}, 15_000);

				await done.promise;
				cleanup();
				unsubscribe();
			});
		},
	);

	router.post(
		"/replays/compare",
		describeRoute({
			tags: ["Replays"],
			summary: "Compare 2–8 Replays",
			description:
				"Returns the full detail rows for the supplied replay ids, preserving caller order so the UI's left-to-right columns match the user's selection.",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: openApiSchemaFromValibot(CompareReplaysRequestSchema) },
				},
			},
			responses: {
				"200": {
					description: "Comparison payload.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(CompareReplaysResponseSchema),
						},
					},
				},
				"400": {
					description: "Body failed validation or selection count out of range.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "One of the ids does not exist.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ReplayNotFoundResponseSchema) },
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
			maxSize: MAX_COMPARE_BODY_BYTES,
			onError: () => {
				throw new ReplayBodyTooLargeError(MAX_COMPARE_BODY_BYTES);
			},
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedReplayBodyError({ cause });
			}
			const parsed = v.safeParse(CompareReplaysRequestSchema, raw);
			if (!parsed.success) {
				const rawIdsCheck = v.safeParse(v.object({ replay_ids: v.array(v.unknown()) }), raw);
				if (rawIdsCheck.success) {
					const len = rawIdsCheck.output.replay_ids.length;
					if (len < COMPARE_MIN || len > COMPARE_MAX) {
						throw new InvalidCompareSelectionError(len, COMPARE_MIN, COMPARE_MAX);
					}
				}
				throw new InvalidReplayRequestError(parsed.issues);
			}
			return c.json(compareReplays(store, parsed.output.replay_ids));
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(
				P.union(P.instanceOf(InvalidReplayRequestError), P.instanceOf(MalformedReplayBodyError)),
				(e) => c.json({ error: "invalid_replay_request", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(InvalidReplayIdError), (e) =>
				c.json({ error: "invalid_replay_id", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(InvalidCompareSelectionError), (e) =>
				c.json({ error: "invalid_compare_selection", count: e.count, min: e.min, max: e.max }, 400),
			)
			.with(P.instanceOf(ReplayBodyTooLargeError), (e) =>
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
			.with(P.instanceOf(ReplayNotFoundError), (e) =>
				c.json({ error: "replay_not_found", replay_id: e.replayId }, 404),
			)
			.with(P.instanceOf(ReplayLifecycleTransitionError), (e) =>
				c.json(
					{
						error: "invalid_lifecycle_transition",
						replay_id: e.replayId,
						from: e.from,
						to: e.to,
					},
					409,
				),
			)
			.with(P.instanceOf(ReplayNotReadyForAnalysisError), (e) =>
				c.json(
					{
						error: "replay_not_ready_for_analysis",
						replay_id: e.replayId,
						current_state: e.currentState,
					},
					409,
				),
			)
			.with(P.instanceOf(Error), (e) => {
				console.error("unhandled error during replay request", e);
				return c.json({ error: "internal_error" }, 500);
			})
			.otherwise((e) => {
				throw e;
			}),
	);

	return router;
}

function parseReplayId(raw: string): string {
	const idCheck = v.safeParse(ReplayIdSchema, raw);
	if (!idCheck.success) throw new InvalidReplayIdError(idCheck.issues);
	return idCheck.output;
}
