import * as v from "valibot";

import {
	ConversationHashSchema,
	HEX_SHA256_RE,
} from "@/server/conversations/conversations.types.ts";

const MAX_RUN_CONFIG_NAME = 256;
const MIN_COMPARE_CONFIGS = 2;
const MAX_COMPARE_CONFIGS = 8;

export const COMPARE_CONFIGS_MIN = MIN_COMPARE_CONFIGS;
export const COMPARE_CONFIGS_MAX = MAX_COMPARE_CONFIGS;

export const RunConfigHashSchema = v.pipe(
	v.string(),
	v.regex(HEX_SHA256_RE, "Must be a 64-char lowercase hex sha256"),
);

/** A label, not prose — capped so it stays renderable in a table header. */
export const RunConfigNameSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(MAX_RUN_CONFIG_NAME),
);

/**
 * Which replays feed the aggregates. `latest` is a scoreboard of current
 * state — one replay per (conversation, config). `all` pools every completed
 * replay in the group, so a flaky config's spread shows up.
 */
export const ReplaySelectionSchema = v.picklist(["latest", "all"]);
export type ReplaySelection = v.InferOutput<typeof ReplaySelectionSchema>;

/**
 * `intersection` restricts aggregates to conversations that *every* selected
 * config completed. Without it, comparing a config that ran 15 conversations
 * against one that ran the 3 easiest is apples to oranges and nothing on
 * screen says so.
 */
export const ConversationScopeSchema = v.picklist(["union", "intersection"]);
export type ConversationScope = v.InferOutput<typeof ConversationScopeSchema>;

/**
 * One metric cell. Every source column is nullable, so `n` travels with the
 * numbers: a mean over 3 samples must not look like a mean over 300. All four
 * fields are null/0 when nothing was measured.
 */
export const MetricAggregateSchema = v.object({
	avg: v.nullable(v.number()),
	p50: v.nullable(v.number()),
	p95: v.nullable(v.number()),
	n: v.number(),
});
export type MetricAggregate = v.InferOutput<typeof MetricAggregateSchema>;

export const InterruptionAggregateSchema = v.object({
	interrupted_turns: v.number(),
	agent_turns: v.number(),
});
export type InterruptionAggregate = v.InferOutput<typeof InterruptionAggregateSchema>;

export const TokenAggregateSchema = v.object({
	avg_input: v.nullable(v.number()),
	avg_output: v.nullable(v.number()),
	avg_total: v.nullable(v.number()),
	n: v.number(),
});
export type TokenAggregate = v.InferOutput<typeof TokenAggregateSchema>;

export const PassAggregateSchema = v.object({
	passed: v.number(),
	total: v.number(),
});
export type PassAggregate = v.InferOutput<typeof PassAggregateSchema>;

export const RunConfigMetricsSchema = v.object({
	ttft_ms: MetricAggregateSchema,
	agent_response_ms: MetricAggregateSchema,
	model_latency_ms: MetricAggregateSchema,
	yield_ms: MetricAggregateSchema,
	interruption: InterruptionAggregateSchema,
	tokens: TokenAggregateSchema,
	pass: PassAggregateSchema,
	// Split out from `pass` because they answer different questions: a replay
	// can fail its verdict on one assertion out of ten, and "1 of 10 checks
	// failed" is a different finding from "the run failed".
	assertions: PassAggregateSchema,
	judges: PassAggregateSchema,
});
export type RunConfigMetrics = v.InferOutput<typeof RunConfigMetricsSchema>;

export const RunConfigCoverageSchema = v.object({
	conversations: v.number(),
	replays: v.number(),
	failed_replays: v.number(),
});
export type RunConfigCoverage = v.InferOutput<typeof RunConfigCoverageSchema>;

export const RunConfigSummarySchema = v.object({
	hash: v.string(),
	name: v.nullable(v.string()),
	config: v.unknown(),
	created_at: v.string(),
	last_run_at: v.nullable(v.string()),
	coverage: RunConfigCoverageSchema,
});
export type RunConfigSummary = v.InferOutput<typeof RunConfigSummarySchema>;

export const ListRunConfigsResponseSchema = v.object({
	items: v.array(RunConfigSummarySchema),
});
export type ListRunConfigsResponse = v.InferOutput<typeof ListRunConfigsResponseSchema>;

export const CompareRunConfigsRequestSchema = v.object({
	config_hashes: v.pipe(
		v.array(RunConfigHashSchema),
		v.minLength(MIN_COMPARE_CONFIGS),
		v.maxLength(MAX_COMPARE_CONFIGS),
		// A repeated hash would render the same config twice and read as two
		// independent results that happen to agree.
		v.check(
			(hashes) => new Set(hashes).size === hashes.length,
			"config_hashes must not contain duplicates",
		),
	),
	replay_selection: v.optional(ReplaySelectionSchema, "latest"),
	conversation_scope: v.optional(ConversationScopeSchema, "union"),
});
export type CompareRunConfigsRequest = v.InferOutput<typeof CompareRunConfigsRequestSchema>;

/**
 * One (config, conversation) cell. Absent rather than zeroed when the config
 * completed nothing for that conversation — a grid has to be able to render
 * "never ran this" differently from "ran it and scored nothing".
 */
export const RunConfigCompareCellSchema = v.object({
	conversation_hash: ConversationHashSchema,
	// Newest included replay for the cell, so a number can be opened in the
	// inspector. Under `all` selection the metrics span more replays than this.
	replay_id: v.string(),
	metrics: RunConfigMetricsSchema,
});
export type RunConfigCompareCell = v.InferOutput<typeof RunConfigCompareCellSchema>;

export const RunConfigGroupResultSchema = v.object({
	hash: v.string(),
	name: v.nullable(v.string()),
	config: v.unknown(),
	coverage: RunConfigCoverageSchema,
	metrics: RunConfigMetricsSchema,
	conversations: v.array(RunConfigCompareCellSchema),
});
export type RunConfigGroupResult = v.InferOutput<typeof RunConfigGroupResultSchema>;

/** A conversation in scope, named once for the whole comparison. */
export const RunConfigComparedConversationSchema = v.object({
	hash: ConversationHashSchema,
	name: v.string(),
});
export type RunConfigComparedConversation = v.InferOutput<
	typeof RunConfigComparedConversationSchema
>;

export const CompareRunConfigsResponseSchema = v.object({
	replay_selection: ReplaySelectionSchema,
	conversation_scope: ConversationScopeSchema,
	// Conversations any selected config ran, and those every config ran. The UI
	// renders coverage as "ran X of `union_conversations`", and the gap between
	// the two numbers is what makes an unfair comparison visible.
	union_conversations: v.number(),
	intersection_conversations: v.number(),
	// The grid's rows: every conversation in scope, named and ordered once so
	// each group's cells align without the client re-deriving the row set.
	conversations: v.array(RunConfigComparedConversationSchema),
	groups: v.array(RunConfigGroupResultSchema),
});
export type CompareRunConfigsResponse = v.InferOutput<typeof CompareRunConfigsResponseSchema>;

export const RunConfigReplayRefSchema = v.object({
	id: v.string(),
	started_at: v.string(),
	passed: v.nullable(v.boolean()),
});
export type RunConfigReplayRef = v.InferOutput<typeof RunConfigReplayRefSchema>;

export const RunConfigConversationRowSchema = v.object({
	conversation_hash: ConversationHashSchema,
	conversation_name: v.string(),
	// The newest included replay — the drill-down's link target, so a run can be
	// listened to in the inspector. Not "the replay these numbers came from":
	// under `all` selection the metrics below span every entry in `replays`.
	replay_id: v.string(),
	// Every included replay for this (conversation, config), newest first. One
	// entry under `latest` selection; the whole run history under `all`.
	replays: v.array(RunConfigReplayRefSchema),
	metrics: RunConfigMetricsSchema,
});
export type RunConfigConversationRow = v.InferOutput<typeof RunConfigConversationRowSchema>;

export const RunConfigDetailResponseSchema = v.object({
	hash: v.string(),
	name: v.nullable(v.string()),
	config: v.unknown(),
	created_at: v.string(),
	replay_selection: ReplaySelectionSchema,
	coverage: RunConfigCoverageSchema,
	metrics: RunConfigMetricsSchema,
	conversations: v.array(RunConfigConversationRowSchema),
});
export type RunConfigDetailResponse = v.InferOutput<typeof RunConfigDetailResponseSchema>;
