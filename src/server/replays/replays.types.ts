import * as v from "valibot";

import {
	ConversationIdSchema,
	ConversationVersionSchema,
} from "@/server/conversations/conversations.types.ts";
import {
	ANALYSIS_STEPS,
	REPLAY_FAILURE_REASONS,
	REPLAY_LIFECYCLE_STATES,
	SPAN_VOCABULARIES,
	TURN_ROLES,
} from "@/server/store/types.ts";

const MAX_RUN_CONFIG_BYTES = 32 * 1024;
const MAX_COMPARE_REPLAYS = 8;
const MIN_COMPARE_REPLAYS = 2;

export const ReplayIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-fA-F-]{36}$/, "Must be a UUID"));

export const ReplayLifecycleStateSchema = v.picklist(REPLAY_LIFECYCLE_STATES);
export const AnalysisStepSchema = v.picklist(ANALYSIS_STEPS);
export const ReplayFailureReasonSchema = v.picklist(REPLAY_FAILURE_REASONS);
export const TurnRoleSchema = v.picklist(TURN_ROLES);
export const SpanVocabularySchema = v.picklist(SPAN_VOCABULARIES);

export const CreateReplayRequestSchema = v.object({
	conversation_id: ConversationIdSchema,
	conversation_version: ConversationVersionSchema,
	run_config: v.optional(v.unknown()),
});
export type CreateReplayRequest = v.InferOutput<typeof CreateReplayRequestSchema>;

export const UpdateReplayRequestSchema = v.object({
	lifecycle_state: v.optional(ReplayLifecycleStateSchema),
	failure_reason: v.optional(v.nullable(ReplayFailureReasonSchema)),
	finished_at: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
});
export type UpdateReplayRequest = v.InferOutput<typeof UpdateReplayRequestSchema>;

export const RUN_CONFIG_MAX_BYTES = MAX_RUN_CONFIG_BYTES;

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
	turn_start_ms: v.number(),
	turn_end_ms: v.number(),
	voice_start_ms: v.number(),
	voice_end_ms: v.number(),
});
export type ReplayTurnResponse = v.InferOutput<typeof ReplayTurnResponseSchema>;

export const SpeechSegmentResponseSchema = v.object({
	id: v.number(),
	channel: TurnRoleSchema,
	start_ms: v.number(),
	end_ms: v.number(),
});
export type SpeechSegmentResponse = v.InferOutput<typeof SpeechSegmentResponseSchema>;

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

export const ReplaySummaryResponseSchema = v.object({
	id: v.string(),
	conversation_id: v.string(),
	conversation_version: v.string(),
	lifecycle_state: ReplayLifecycleStateSchema,
	analysis_step: v.nullable(AnalysisStepSchema),
	failure_reason: v.nullable(ReplayFailureReasonSchema),
	started_at: v.string(),
	finished_at: v.nullable(v.string()),
	run_config: v.unknown(),
});
export type ReplaySummaryResponse = v.InferOutput<typeof ReplaySummaryResponseSchema>;

export const ReplayDetailResponseSchema = v.object({
	id: v.string(),
	conversation_id: v.string(),
	conversation_version: v.string(),
	lifecycle_state: ReplayLifecycleStateSchema,
	analysis_step: v.nullable(AnalysisStepSchema),
	failure_reason: v.nullable(ReplayFailureReasonSchema),
	started_at: v.string(),
	finished_at: v.nullable(v.string()),
	audio_path: v.nullable(v.string()),
	job_id: v.nullable(v.string()),
	run_config: v.unknown(),
	turns: v.array(ReplayTurnResponseSchema),
	speech_segments: v.array(SpeechSegmentResponseSchema),
	tool_calls: v.array(ToolCallResponseSchema),
	model_usage: v.array(ModelUsageResponseSchema),
	spans: v.array(SpanResponseSchema),
});
export type ReplayDetailResponse = v.InferOutput<typeof ReplayDetailResponseSchema>;

export const AnalyzeReplayResponseSchema = v.object({
	job_id: v.string(),
	lifecycle_state: ReplayLifecycleStateSchema,
});
export type AnalyzeReplayResponse = v.InferOutput<typeof AnalyzeReplayResponseSchema>;

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
