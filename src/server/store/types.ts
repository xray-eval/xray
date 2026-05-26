import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type {
	assertionResults,
	conversations,
	judgeResults,
	modelUsage,
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	spans,
	speechSegments,
	toolCalls,
	turnTranscripts,
} from "./schema.ts";

export const REPLAY_LIFECYCLE_STATES = [
	"pending",
	"running",
	"recording_uploaded",
	"analyzing",
	"completed",
	"failed",
] as const;
export type ReplayLifecycleState = (typeof REPLAY_LIFECYCLE_STATES)[number];

// Server-internal analysis sub-state. Surfaced via SSE so the SDK / inspector
// can show progress through the chained job pipeline. Null outside
// `lifecycle_state='analyzing'`. Order is the chain order:
//   `analyze-replay` runs `vad` then `transcribe`;
//   `calculate-metrics` runs `metrics`;
//   `evaluate-replay` runs `evaluate`.
export const ANALYSIS_STEPS = ["vad", "transcribe", "metrics", "evaluate"] as const;
export type AnalysisStep = (typeof ANALYSIS_STEPS)[number];

// Reasons that explain a `failed` replay. Three groups:
//   1. bunqueue DLQ reasons surfaced by the analyze-replay worker
//      (`stalled`, `timeout`, `explicit_fail`, `max_attempts_exceeded`,
//      `worker_lost`).
//   2. SDK / control-plane failures the driver reports via PATCH
//      (`driver_aborted` = generic SDK-side failure, `upload_failed`
//      = audio upload step failed, `agent_not_joined` = LiveKit agent
//      participant never joined the room, `audio_missing` = a turn
//      referenced audio bytes the SDK could not produce).
//   3. Pipeline-stage failures stamped by each chained job
//      (`transcription_failed`, `metrics_failed`, `evaluation_failed`).
//      The job that failed names itself so the driver can decide whether
//      to retry the run vs. flag a flaky provider. `spec_vad_mismatch` is
//      a sub-class of evaluation failure: the conversation spec's turn
//      sequence can't be aligned to the VAD-derived turn sequence (e.g.
//      spec expects 3 turns but VAD detected 1, or roles diverge by
//      position). `missing_credential` is the analyze chain's "operator
//      forgot to set the configured provider's API key" signal
//      (`OPENAI_API_KEY` / `GOOGLE_API_KEY` depending on selector) —
//      distinct from `transcription_failed` / `evaluation_failed` so the
//      README pointer surfaces cleanly.
//
// The SDK's `xray.errors.FailureReason` literal MUST be a subset of this
// list — enforced by the contract test at
// `src/server/replays/replays.failure-reason-contract.test.ts`.
export const REPLAY_FAILURE_REASONS = [
	"stalled",
	"timeout",
	"explicit_fail",
	"max_attempts_exceeded",
	"worker_lost",
	"upload_failed",
	"driver_aborted",
	"agent_not_joined",
	"audio_missing",
	"missing_credential",
	"transcription_failed",
	"metrics_failed",
	"evaluation_failed",
	"spec_vad_mismatch",
] as const;
export type ReplayFailureReason = (typeof REPLAY_FAILURE_REASONS)[number];

// Role of a turn on the script OR channel of a speech segment.
export const TURN_ROLES = ["user", "agent"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

// Recognized OTLP span vocabularies.
export const SPAN_VOCABULARIES = ["xray", "gen_ai", "langfuse"] as const;
export type SpanVocabulary = (typeof SPAN_VOCABULARIES)[number];

/** A row in `conversations`. Primary key is `hash` (SHA-256 of canonicalized turns). */
export type ConversationRow = InferSelectModel<typeof conversations>;
export type ConversationInput = InferInsertModel<typeof conversations>;

export type ReplayRow = InferSelectModel<typeof replays>;
export type ReplayInput = InferInsertModel<typeof replays>;

export type SpeechSegmentRow = InferSelectModel<typeof speechSegments>;
export type SpeechSegmentInput = InferInsertModel<typeof speechSegments>;

export type ReplayTurnRow = InferSelectModel<typeof replayTurns>;
export type ReplayTurnInput = InferInsertModel<typeof replayTurns>;

export type SpanRow = InferSelectModel<typeof spans>;
export type SpanInput = InferInsertModel<typeof spans>;

export type ToolCallRow = InferSelectModel<typeof toolCalls>;
export type ToolCallInput = InferInsertModel<typeof toolCalls>;

export type ModelUsageRow = InferSelectModel<typeof modelUsage>;
export type ModelUsageInput = InferInsertModel<typeof modelUsage>;

// Per-turn transcripts produced by the transcription stage of analyze-replay.
export type TurnTranscriptRow = InferSelectModel<typeof turnTranscripts>;
export type TurnTranscriptInput = InferInsertModel<typeof turnTranscripts>;

// Per-turn timing metrics produced by calculate-metrics.
export type ReplayMetricRow = InferSelectModel<typeof replayMetrics>;
export type ReplayMetricInput = InferInsertModel<typeof replayMetrics>;

// One row per (replay, turn, assertion) — written by evaluate-replay.
export type AssertionResultRow = InferSelectModel<typeof assertionResults>;
export type AssertionResultInput = InferInsertModel<typeof assertionResults>;

// One row per (replay, judge) — written by evaluate-replay.
export type JudgeResultRow = InferSelectModel<typeof judgeResults>;
export type JudgeResultInput = InferInsertModel<typeof judgeResults>;

// One row per replay — written by evaluate-replay on chain success.
export type ReplayEvaluationRow = InferSelectModel<typeof replayEvaluations>;
export type ReplayEvaluationInput = InferInsertModel<typeof replayEvaluations>;

// Status enum shared by assertion + judge result rows.
export const EVALUATION_STATUSES = ["passed", "failed", "errored"] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
