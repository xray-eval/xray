import * as v from "valibot";

import {
	ConversationIdSchema,
	ConversationVersionSchema,
} from "@/server/conversations/conversations.types.ts";
import {
	ASSERTION_STATUSES,
	JUDGE_STATUSES,
	REPLAY_FAILURE_REASONS,
	REPLAY_MODALITIES,
	REPLAY_STATUSES,
	SPAN_VOCABULARIES,
	TURN_ROLES,
} from "@/server/store/types.ts";

const MAX_RUN_CONFIG_BYTES = 32 * 1024;
const MAX_JUDGE_REASON = 4 * 1024;
const MAX_TRANSCRIPT = 1024 * 1024;
const MAX_COMPARE_REPLAYS = 8;
const MIN_COMPARE_REPLAYS = 2;

export const ReplayIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-fA-F-]{36}$/, "Must be a UUID"));

export const ReplayStatusSchema = v.picklist(REPLAY_STATUSES);
export const ReplayFailureReasonSchema = v.picklist(REPLAY_FAILURE_REASONS);
export const ReplayModalitySchema = v.picklist(REPLAY_MODALITIES);
export const JudgeStatusSchema = v.picklist(JUDGE_STATUSES);
export const AssertionStatusSchema = v.picklist(ASSERTION_STATUSES);
export const TurnRoleSchema = v.picklist(TURN_ROLES);
export const SpanVocabularySchema = v.picklist(SPAN_VOCABULARIES);

/**
 * Body of `POST /v1/replays`. The SDK posts this before joining the room
 * so the replay row exists when the first OTLP span arrives. `run_config`
 * is a free-form JSON blob — xray stores it opaquely and surfaces it in
 * the UI for diffs across the same Conversation.
 */
export const CreateReplayRequestSchema = v.object({
	conversation_id: ConversationIdSchema,
	conversation_version: ConversationVersionSchema,
	modality: v.optional(ReplayModalitySchema, "voice"),
	run_config: v.optional(v.unknown()),
});
export type CreateReplayRequest = v.InferOutput<typeof CreateReplayRequestSchema>;

/**
 * Body of `PATCH /v1/replays/:id`. Every field is optional; the SDK calls
 * this multiple times during a run to set status, then judge result, etc.
 * Validation enforces value vocabularies; the service enforces transition
 * legality (e.g. can't move out of `failed`).
 */
export const UpdateReplayRequestSchema = v.object({
	status: v.optional(ReplayStatusSchema),
	failure_reason: v.optional(v.nullable(ReplayFailureReasonSchema)),
	finished_at: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
	transcript: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(MAX_TRANSCRIPT)))),
	audio_path: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(1024)))),
	run_config: v.optional(v.nullable(v.unknown())),
	judge: v.optional(
		v.object({
			status: JudgeStatusSchema,
			score: v.optional(v.nullable(v.pipe(v.number(), v.integer()))),
			reason: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(MAX_JUDGE_REASON)))),
			error: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(MAX_JUDGE_REASON)))),
		}),
	),
});
export type UpdateReplayRequest = v.InferOutput<typeof UpdateReplayRequestSchema>;

export const RUN_CONFIG_MAX_BYTES = MAX_RUN_CONFIG_BYTES;

/** A single tool call (extracted from a recognized span). */
export const ToolCallResponseSchema = v.object({
	id: v.number(),
	turn_idx: v.nullable(v.number()),
	span_id: v.nullable(v.string()),
	name: v.string(),
	args_json: v.nullable(v.string()),
	result_json: v.nullable(v.string()),
	started_at: v.nullable(v.string()),
	ended_at: v.nullable(v.string()),
	latency_ms: v.nullable(v.number()),
});
export type ToolCallResponse = v.InferOutput<typeof ToolCallResponseSchema>;

export const ModelUsageResponseSchema = v.object({
	id: v.number(),
	turn_idx: v.nullable(v.number()),
	span_id: v.nullable(v.string()),
	provider: v.nullable(v.string()),
	model: v.nullable(v.string()),
	input_tokens: v.nullable(v.number()),
	output_tokens: v.nullable(v.number()),
	total_tokens: v.nullable(v.number()),
	started_at: v.nullable(v.string()),
	ended_at: v.nullable(v.string()),
	latency_ms: v.nullable(v.number()),
});
export type ModelUsageResponse = v.InferOutput<typeof ModelUsageResponseSchema>;

export const ReplayTurnResponseSchema = v.object({
	idx: v.number(),
	role: TurnRoleSchema,
	key: v.nullable(v.string()),
	started_at: v.nullable(v.string()),
	ended_at: v.nullable(v.string()),
	transcript: v.nullable(v.string()),
	audio_path: v.nullable(v.string()),
});
export type ReplayTurnResponse = v.InferOutput<typeof ReplayTurnResponseSchema>;

export const AssertionResponseSchema = v.object({
	id: v.number(),
	turn_idx: v.number(),
	name: v.string(),
	status: AssertionStatusSchema,
	message: v.nullable(v.string()),
	recorded_at: v.string(),
});
export type AssertionResponse = v.InferOutput<typeof AssertionResponseSchema>;

export const SpanResponseSchema = v.object({
	id: v.number(),
	trace_id: v.string(),
	span_id: v.string(),
	parent_span_id: v.nullable(v.string()),
	name: v.string(),
	vocabulary: SpanVocabularySchema,
	started_at: v.string(),
	ended_at: v.string(),
	attributes_json: v.string(),
});
export type SpanResponse = v.InferOutput<typeof SpanResponseSchema>;

/** Summary fields returned by `GET /v1/conversations/:id/replays`. */
export const ReplaySummaryResponseSchema = v.object({
	id: v.string(),
	conversation_id: v.string(),
	conversation_version: v.string(),
	status: ReplayStatusSchema,
	failure_reason: v.nullable(ReplayFailureReasonSchema),
	modality: ReplayModalitySchema,
	started_at: v.string(),
	finished_at: v.nullable(v.string()),
	judge_status: v.nullable(JudgeStatusSchema),
	judge_score: v.nullable(v.number()),
	run_config: v.unknown(),
});
export type ReplaySummaryResponse = v.InferOutput<typeof ReplaySummaryResponseSchema>;

/** Full detail returned by `GET /v1/replays/:id`. */
export const ReplayDetailResponseSchema = v.object({
	id: v.string(),
	conversation_id: v.string(),
	conversation_version: v.string(),
	status: ReplayStatusSchema,
	failure_reason: v.nullable(ReplayFailureReasonSchema),
	modality: ReplayModalitySchema,
	started_at: v.string(),
	finished_at: v.nullable(v.string()),
	audio_path: v.nullable(v.string()),
	transcript: v.nullable(v.string()),
	run_config: v.unknown(),
	judge: v.object({
		status: v.nullable(JudgeStatusSchema),
		score: v.nullable(v.number()),
		reason: v.nullable(v.string()),
		error: v.nullable(v.string()),
	}),
	turns: v.array(ReplayTurnResponseSchema),
	assertions: v.array(AssertionResponseSchema),
	tool_calls: v.array(ToolCallResponseSchema),
	model_usage: v.array(ModelUsageResponseSchema),
	spans: v.array(SpanResponseSchema),
});
export type ReplayDetailResponse = v.InferOutput<typeof ReplayDetailResponseSchema>;

export const ListReplaysResponseSchema = v.object({
	items: v.array(ReplaySummaryResponseSchema),
});
export type ListReplaysResponse = v.InferOutput<typeof ListReplaysResponseSchema>;

export const CompareReplaysRequestSchema = v.object({
	replay_ids: v.pipe(
		v.array(ReplayIdSchema),
		v.minLength(MIN_COMPARE_REPLAYS),
		v.maxLength(MAX_COMPARE_REPLAYS),
	),
});
export type CompareReplaysRequest = v.InferOutput<typeof CompareReplaysRequestSchema>;

export const CompareReplaysResponseSchema = v.object({
	replays: v.array(ReplayDetailResponseSchema),
});
export type CompareReplaysResponse = v.InferOutput<typeof CompareReplaysResponseSchema>;

export const COMPARE_MIN = MIN_COMPARE_REPLAYS;
export const COMPARE_MAX = MAX_COMPARE_REPLAYS;
