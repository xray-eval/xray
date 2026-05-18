import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type {
	assertions,
	conversations,
	modelUsage,
	replayMeta,
	replays,
	replayTurns,
	spans,
	toolCalls,
} from "./schema.ts";

// One source of truth: the runtime-visible array drives the Valibot picklist
// at the wire boundary AND the static union type.
export const REPLAY_STATUSES = ["running", "completed", "failed"] as const;
export type ReplayStatus = (typeof REPLAY_STATUSES)[number];

// Reasons that explain a `failed` replay. Always paired with `status='failed'`.
export const REPLAY_FAILURE_REASONS = [
	"agent_not_joined",
	"runtime_error",
	"audio_missing",
	"sdk_aborted",
	"other",
] as const;
export type ReplayFailureReason = (typeof REPLAY_FAILURE_REASONS)[number];

// Judge result. `errored` is a first-class state, not a synonym for null —
// it means the judge ran and the LLM call itself failed.
export const JUDGE_STATUSES = ["pending", "passed", "failed", "errored"] as const;
export type JudgeStatus = (typeof JUDGE_STATUSES)[number];

// Assertion result for one turn. `errored` covers the predicate itself
// throwing — separate from a clean `fail`.
export const ASSERTION_STATUSES = ["passed", "failed", "errored"] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

// Conversation turn role on the script. Voice in v1 is two-sided.
export const TURN_ROLES = ["user", "agent"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

// Modality of the recorded run. Voice in v1; video/text reserved without a
// schema migration — receiver only enforces 'voice' for now.
export const REPLAY_MODALITIES = ["voice"] as const;
export type ReplayModality = (typeof REPLAY_MODALITIES)[number];

// Recognized OTLP span vocabularies. Used when persisting raw spans so the
// inspector can group + label without re-parsing attributes.
export const SPAN_VOCABULARIES = ["xray", "gen_ai", "langfuse"] as const;
export type SpanVocabulary = (typeof SPAN_VOCABULARIES)[number];

/** A row in `conversations`. Composite primary key is `(id, version)`. */
export type ConversationRow = InferSelectModel<typeof conversations>;
export type ConversationInput = InferInsertModel<typeof conversations>;

/** A row in `replays`. */
export type ReplayRow = InferSelectModel<typeof replays>;
export type ReplayInput = InferInsertModel<typeof replays>;

/** A row in `replay_meta`. 1:1 with `replays`. */
export type ReplayMetaRow = InferSelectModel<typeof replayMeta>;
export type ReplayMetaInput = InferInsertModel<typeof replayMeta>;

/** A row in `replay_turns`. Indexed under a replay. */
export type ReplayTurnRow = InferSelectModel<typeof replayTurns>;
export type ReplayTurnInput = InferInsertModel<typeof replayTurns>;

/** A raw OTLP span persisted under a replay. */
export type SpanRow = InferSelectModel<typeof spans>;
export type SpanInput = InferInsertModel<typeof spans>;

/** A tool call extracted from a recognized span. */
export type ToolCallRow = InferSelectModel<typeof toolCalls>;
export type ToolCallInput = InferInsertModel<typeof toolCalls>;

/** LLM token-usage row extracted from gen_ai or langfuse spans. */
export type ModelUsageRow = InferSelectModel<typeof modelUsage>;
export type ModelUsageInput = InferInsertModel<typeof modelUsage>;

/** Per-turn assertion result posted by the SDK. */
export type AssertionRow = InferSelectModel<typeof assertions>;
export type AssertionInput = InferInsertModel<typeof assertions>;
