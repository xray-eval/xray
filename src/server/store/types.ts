import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type {
	conversations,
	modelUsage,
	replays,
	replayTurns,
	spans,
	speechSegments,
	toolCalls,
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

// Server-internal analysis sub-state. Surfaced via SSE but not used by the
// driver-facing lifecycle. Null outside `lifecycle_state='analyzing'`.
export const ANALYSIS_STEPS = ["vad", "turns"] as const;
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
] as const;
export type ReplayFailureReason = (typeof REPLAY_FAILURE_REASONS)[number];

// Role of a turn on the script OR channel of a speech segment.
export const TURN_ROLES = ["user", "agent"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

// Recognized OTLP span vocabularies.
export const SPAN_VOCABULARIES = ["xray", "gen_ai", "langfuse"] as const;
export type SpanVocabulary = (typeof SPAN_VOCABULARIES)[number];

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
