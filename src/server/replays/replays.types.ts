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
 * so the replay row exists when the first OTLP span arrives. `runConfig`
 * is a free-form JSON blob — xray stores it opaquely and surfaces it in
 * the UI for diffs across the same Conversation.
 */
export const CreateReplayRequestSchema = v.object({
	conversationId: ConversationIdSchema,
	conversationVersion: ConversationVersionSchema,
	modality: v.optional(ReplayModalitySchema, "voice"),
	runConfig: v.optional(v.unknown()),
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
	failureReason: v.optional(v.nullable(ReplayFailureReasonSchema)),
	finishedAt: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
	transcript: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(MAX_TRANSCRIPT)))),
	audioPath: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(1024)))),
	runConfig: v.optional(v.nullable(v.unknown())),
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
	turnIdx: v.nullable(v.number()),
	spanId: v.nullable(v.string()),
	name: v.string(),
	argsJson: v.nullable(v.string()),
	resultJson: v.nullable(v.string()),
	startedAt: v.nullable(v.string()),
	endedAt: v.nullable(v.string()),
	latencyMs: v.nullable(v.number()),
});
export type ToolCallResponse = v.InferOutput<typeof ToolCallResponseSchema>;

export const ModelUsageResponseSchema = v.object({
	id: v.number(),
	turnIdx: v.nullable(v.number()),
	spanId: v.nullable(v.string()),
	provider: v.nullable(v.string()),
	model: v.nullable(v.string()),
	inputTokens: v.nullable(v.number()),
	outputTokens: v.nullable(v.number()),
	totalTokens: v.nullable(v.number()),
	startedAt: v.nullable(v.string()),
	endedAt: v.nullable(v.string()),
	latencyMs: v.nullable(v.number()),
});
export type ModelUsageResponse = v.InferOutput<typeof ModelUsageResponseSchema>;

export const ReplayTurnResponseSchema = v.object({
	idx: v.number(),
	role: TurnRoleSchema,
	key: v.nullable(v.string()),
	startedAt: v.nullable(v.string()),
	endedAt: v.nullable(v.string()),
	transcript: v.nullable(v.string()),
	audioPath: v.nullable(v.string()),
});
export type ReplayTurnResponse = v.InferOutput<typeof ReplayTurnResponseSchema>;

export const AssertionResponseSchema = v.object({
	id: v.number(),
	turnIdx: v.number(),
	name: v.string(),
	status: AssertionStatusSchema,
	message: v.nullable(v.string()),
	recordedAt: v.string(),
});
export type AssertionResponse = v.InferOutput<typeof AssertionResponseSchema>;

export const SpanResponseSchema = v.object({
	id: v.number(),
	traceId: v.string(),
	spanId: v.string(),
	parentSpanId: v.nullable(v.string()),
	name: v.string(),
	vocabulary: SpanVocabularySchema,
	startedAt: v.string(),
	endedAt: v.string(),
	attributesJson: v.string(),
});
export type SpanResponse = v.InferOutput<typeof SpanResponseSchema>;

/** Summary fields returned by `GET /v1/conversations/:id/replays`. */
export const ReplaySummaryResponseSchema = v.object({
	id: v.string(),
	conversationId: v.string(),
	conversationVersion: v.string(),
	status: ReplayStatusSchema,
	failureReason: v.nullable(ReplayFailureReasonSchema),
	modality: ReplayModalitySchema,
	startedAt: v.string(),
	finishedAt: v.nullable(v.string()),
	judgeStatus: v.nullable(JudgeStatusSchema),
	judgeScore: v.nullable(v.number()),
	runConfig: v.unknown(),
});
export type ReplaySummaryResponse = v.InferOutput<typeof ReplaySummaryResponseSchema>;

/** Full detail returned by `GET /v1/replays/:id`. */
export const ReplayDetailResponseSchema = v.object({
	id: v.string(),
	conversationId: v.string(),
	conversationVersion: v.string(),
	status: ReplayStatusSchema,
	failureReason: v.nullable(ReplayFailureReasonSchema),
	modality: ReplayModalitySchema,
	startedAt: v.string(),
	finishedAt: v.nullable(v.string()),
	audioPath: v.nullable(v.string()),
	transcript: v.nullable(v.string()),
	runConfig: v.unknown(),
	judge: v.object({
		status: v.nullable(JudgeStatusSchema),
		score: v.nullable(v.number()),
		reason: v.nullable(v.string()),
		error: v.nullable(v.string()),
	}),
	turns: v.array(ReplayTurnResponseSchema),
	assertions: v.array(AssertionResponseSchema),
	toolCalls: v.array(ToolCallResponseSchema),
	modelUsage: v.array(ModelUsageResponseSchema),
	spans: v.array(SpanResponseSchema),
});
export type ReplayDetailResponse = v.InferOutput<typeof ReplayDetailResponseSchema>;

export const ListReplaysResponseSchema = v.object({
	items: v.array(ReplaySummaryResponseSchema),
});
export type ListReplaysResponse = v.InferOutput<typeof ListReplaysResponseSchema>;

export const CompareReplaysRequestSchema = v.object({
	replayIds: v.pipe(
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
