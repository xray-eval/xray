import * as v from "valibot";

import { ConversationHashSchema } from "@/server/conversations/conversations.types.ts";
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

/**
 * Body of `POST /v1/replays` (JSON). The SDK POSTs `/v1/conversations`
 * first to upsert the conversation row (server hashes the canonical
 * turn JSON and returns the `conversation_hash`), then references that
 * hash here. The SDK should propagate the returned `id`
 * (xray.replay.id) onto the voice service BEFORE its first OTEL span.
 */
export const CreateReplayRequestSchema = v.object({
	conversation_hash: ConversationHashSchema,
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
	// Offset on the audio timeline (ms from recording t=0), derived from
	// started_at − replays.recording_started_at. Null when either is missing
	// — the row is still listed; it just can't be placed on the timeline.
	audio_offset_ms: v.nullable(v.number()),
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
	audio_offset_ms: v.nullable(v.number()),
	span_id: v.nullable(v.string()),
	provider: v.nullable(v.string()),
	model: v.nullable(v.string()),
	input_tokens: v.nullable(v.number()),
	output_tokens: v.nullable(v.number()),
	total_tokens: v.nullable(v.number()),
	// Model time-to-first-token (ms), from gen_ai.response.time_to_first_chunk.
	// Null when the agent's instrumentation doesn't emit it.
	ttft_ms: v.nullable(v.number()),
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

/**
 * One word, parsed from `turn_transcripts.words_json`. Timings are 0-based
 * within the turn's audio slice (Whisper transcribes the per-turn slice cut at
 * `voice_start_ms`), not recording-absolute — the inspector shifts by the
 * turn's voice-window start when syncing words to the playhead.
 */
export const TranscriptWordSchema = v.object({
	text: v.string(),
	start_ms: v.number(),
	end_ms: v.number(),
});
export type TranscriptWord = v.InferOutput<typeof TranscriptWordSchema>;

/**
 * Per-turn Whisper transcript. `words` is null when the provider returned no
 * word-level timings (Gemini) — the UI falls back to plain text in that case.
 */
export const TurnTranscriptResponseSchema = v.object({
	turn_idx: v.number(),
	text: v.string(),
	language: v.nullable(v.string()),
	words: v.nullable(v.array(TranscriptWordSchema)),
	duration_ms: v.number(),
	provider: v.string(),
	model: v.string(),
});
export type TurnTranscriptResponse = v.InferOutput<typeof TurnTranscriptResponseSchema>;

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
	// Offset of started_at on the audio timeline (ms from recording t=0),
	// derived from started_at − replays.recording_started_at. Null when the
	// replay has no anchor — the span is then unplaceable and renders untimed.
	// The single origin for client span placement (spec 0001 §3.2): the client
	// never re-derives offsets from wall-clock, so it can't diverge from the
	// assertion evaluator's view.
	audio_offset_ms: v.nullable(v.number()),
});
export type SpanResponse = v.InferOutput<typeof SpanResponseSchema>;

/**
 * Per-turn timing — the silence/gap before an agent responds
 * (`agent_response_ms`) and barge-in. Observability data: rides the replay
 * detail (Run details UI) AND the evaluation result (SDK
 * `ReplayResult.metrics`). Model TTFT is no longer a per-turn metric — it's an
 * optional per-call attribute (`model_usage.ttft_ms`, spec 0001).
 */
export const TurnMetricsResponseSchema = v.object({
	turn_idx: v.number(),
	role: TurnRoleSchema,
	agent_response_ms: v.nullable(v.number()),
	interrupted: v.boolean(),
	interruption_start_ms: v.nullable(v.number()),
});
export type TurnMetricsResponse = v.InferOutput<typeof TurnMetricsResponseSchema>;

/** Summary fields returned by `GET /v1/conversations/:hash/replays`. */
export const ReplaySummaryResponseSchema = v.object({
	id: v.string(),
	conversation_hash: ConversationHashSchema,
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
	conversation_hash: ConversationHashSchema,
	lifecycle_state: ReplayLifecycleStateSchema,
	analysis_step: v.nullable(AnalysisStepSchema),
	failure_reason: v.nullable(ReplayFailureReasonSchema),
	started_at: v.string(),
	finished_at: v.nullable(v.string()),
	// Wall-clock of audio sample 0 (the timeline origin). The client maps any
	// wall-clock timestamp (spans, tool calls, model usage) onto the audio
	// timeline with `started_at − recording_started_at`. Null for older
	// uploads that omitted the X-Recording-Started-At header.
	recording_started_at: v.nullable(v.string()),
	audio_path: v.nullable(v.string()),
	job_id: v.nullable(v.string()),
	run_config: v.unknown(),
	turns: v.array(ReplayTurnResponseSchema),
	speech_segments: v.array(SpeechSegmentResponseSchema),
	transcripts: v.array(TurnTranscriptResponseSchema),
	turn_metrics: v.array(TurnMetricsResponseSchema),
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

// ─── Evaluation result (Spec 0001 §11) ────────────────────────────────
// Returned by GET /v1/replays/:id/result and shipped as the payload of
// the `evaluation_complete` SSE event. The SDK projects this into its
// `ReplayResult` dataclass — the wire shape and the SDK shape are
// intentionally identical so future-language SDKs need no transformation.

const EvaluationStatusSchema = v.picklist(["passed", "failed", "errored"]);

export const AssertionOutcomeResponseSchema = v.object({
	turn_idx: v.number(),
	assertion_idx: v.number(),
	kind: v.string(),
	status: EvaluationStatusSchema,
	message: v.nullable(v.string()),
});
export type AssertionOutcomeResponse = v.InferOutput<typeof AssertionOutcomeResponseSchema>;

export const JudgeOutcomeResponseSchema = v.object({
	judge_idx: v.number(),
	kind: v.string(),
	status: EvaluationStatusSchema,
	score: v.nullable(v.number()),
	reason: v.nullable(v.string()),
});
export type JudgeOutcomeResponse = v.InferOutput<typeof JudgeOutcomeResponseSchema>;

export const ReplayResultSchema = v.object({
	replay_id: v.string(),
	conversation_hash: ConversationHashSchema,
	passed: v.boolean(),
	assertions: v.array(AssertionOutcomeResponseSchema),
	judges: v.array(JudgeOutcomeResponseSchema),
	metrics: v.object({
		turns: v.array(TurnMetricsResponseSchema),
	}),
});
export type ReplayResult = v.InferOutput<typeof ReplayResultSchema>;
