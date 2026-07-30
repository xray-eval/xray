import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	BodyTooLargeResponseSchema,
	openApiSchemaFromValibot,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	InvalidRunConfigHashError,
	InvalidRunConfigRequestError,
	MalformedRunConfigBodyError,
	RunConfigBodyTooLargeError,
	RunConfigNotFoundError,
} from "./run-configs.errors.ts";
import { compareRunConfigs, getRunConfigDetail, listRunConfigs } from "./run-configs.service.ts";
import type { ReplaySelection } from "./run-configs.types.ts";
import {
	COMPARE_CONFIGS_MAX,
	COMPARE_CONFIGS_MIN,
	CompareRunConfigsRequestSchema,
	CompareRunConfigsResponseSchema,
	ListRunConfigsResponseSchema,
	ReplaySelectionSchema,
	RunConfigDetailResponseSchema,
	RunConfigHashSchema,
} from "./run-configs.types.ts";

const MAX_COMPARE_BODY_BYTES = 16 * 1024;

const RunConfigNotFoundResponseSchema = v.object({
	error: v.string(),
	config_hash: v.string(),
});

export function createRunConfigsRouter(store: Store): Hono {
	const router = new Hono();

	router.get(
		"/run-configs",
		describeRoute({
			tags: ["Run configs"],
			summary: "List run-config groups",
			description:
				"Every configuration any replay has run under, most recently active first. `coverage` spans the whole group (not the `latest`-per-conversation subset) so the picker can show how much a config has been exercised before you select it. Replays that carried no `run_config` belong to no group and are absent here.",
			responses: {
				"200": {
					description: "All run-config groups.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ListRunConfigsResponseSchema) },
					},
				},
			},
		}),
		(c) => c.json(listRunConfigs(store)),
	);

	router.post(
		"/run-configs/compare",
		describeRoute({
			tags: ["Run configs"],
			summary: "Compare run-config groups",
			description: `Aggregate ${COMPARE_CONFIGS_MIN}..${COMPARE_CONFIGS_MAX} config groups over the conversations they ran. Only \`completed\` replays feed the metrics; failed ones are counted separately per group. Every metric cell carries its own sample size \`n\`, because each source column is optional at capture time. \`conversation_scope: "intersection"\` restricts the aggregates to conversations every selected config completed — without it, a config that ran 15 conversations and one that ran the 3 easiest compare on different workloads.`,
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: openApiSchemaFromValibot(CompareRunConfigsRequestSchema),
					},
				},
			},
			responses: {
				"200": {
					description: "Per-group aggregates plus the coverage counts.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(CompareRunConfigsResponseSchema),
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
					description: "One of the `config_hashes` doesn't exist.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(RunConfigNotFoundResponseSchema),
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
			maxSize: MAX_COMPARE_BODY_BYTES,
			onError: () => {
				throw new RunConfigBodyTooLargeError(MAX_COMPARE_BODY_BYTES);
			},
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedRunConfigBodyError({ cause });
			}
			const parsed = v.safeParse(CompareRunConfigsRequestSchema, raw);
			if (!parsed.success) throw new InvalidRunConfigRequestError(parsed.issues);
			return c.json(compareRunConfigs(store, parsed.output));
		},
	);

	router.get(
		"/run-configs/:hash",
		describeRoute({
			tags: ["Run configs"],
			summary: "One run-config group across its conversations",
			description:
				"The drill-down: every conversation this config ran, with per-conversation metrics. Each row carries `replay_id` — the newest included replay — so the UI can link straight to the inspector and the run can be listened to. Under `replay_selection=all` the row's `metrics` are aggregated over every entry in `replays[]` (the full run history for that conversation, newest first), so they span more runs than `replay_id` alone; under `latest`, `replays[]` holds that one replay and the metrics are its own.",
			parameters: [
				{
					in: "path",
					name: "hash",
					required: true,
					schema: openApiSchemaFromValibot(RunConfigHashSchema),
				},
				{
					in: "query",
					name: "replay_selection",
					required: false,
					schema: openApiSchemaFromValibot(ReplaySelectionSchema),
				},
			],
			responses: {
				"200": {
					description: "The group, its aggregates, and its per-conversation breakdown.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(RunConfigDetailResponseSchema),
						},
					},
				},
				"400": {
					description: "`hash` or `replay_selection` failed validation.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"404": {
					description: "Run-config group not found.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(RunConfigNotFoundResponseSchema),
						},
					},
				},
			},
		}),
		(c) => {
			const hash = parseRunConfigHash(c.req.param("hash"));
			const selection = parseReplaySelection(c.req.query("replay_selection"));
			return c.json(getRunConfigDetail(store, hash, selection));
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(P.instanceOf(InvalidRunConfigHashError), (e) =>
				c.json({ error: "invalid_run_config_hash", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(
				P.union(
					P.instanceOf(InvalidRunConfigRequestError),
					P.instanceOf(MalformedRunConfigBodyError),
				),
				(e) =>
					c.json({ error: "invalid_run_config_request", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(RunConfigBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", max_bytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(RunConfigNotFoundError), (e) =>
				c.json({ error: "run_config_not_found", config_hash: e.configHash }, 404),
			)
			.with(P.instanceOf(Error), (e) => {
				console.error("unhandled error during run-config request", e);
				return c.json({ error: "internal_error" }, 500);
			})
			.otherwise((e) => {
				throw e;
			}),
	);

	return router;
}

function parseRunConfigHash(raw: string): string {
	const result = v.safeParse(RunConfigHashSchema, raw);
	if (!result.success) throw new InvalidRunConfigHashError(result.issues);
	return result.output;
}

/** Absent query param means the default scoreboard view, not a bad request. */
function parseReplaySelection(raw: string | undefined): ReplaySelection {
	if (raw === undefined) return "latest";
	const result = v.safeParse(ReplaySelectionSchema, raw);
	if (!result.success) throw new InvalidRunConfigRequestError(result.issues);
	return result.output;
}
