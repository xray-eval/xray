import * as v from "valibot";

import type { ModelUsageRow, ToolCallRow, TurnRole } from "@/server/store/types.ts";

// Hard caps. Pathological assertion strings would inflate the
// conversation hash and the per-turn evaluator's working set without
// adding test value. Raise if a real test ever needs more.
export const MAX_ASSERTION_TEXT = 2048;
export const MAX_ASSERTION_PATTERN = 2048;
export const MAX_TOOL_NAME = 256;
export const MAX_ASSERTIONS_PER_TURN = 32;

const ContainsAssertionSchema = v.object({
	kind: v.literal("contains"),
	text: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_ASSERTION_TEXT)),
	case_insensitive: v.optional(v.boolean(), true),
});

const NotContainsAssertionSchema = v.object({
	kind: v.literal("not_contains"),
	text: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_ASSERTION_TEXT)),
	case_insensitive: v.optional(v.boolean(), true),
});

const RegexAssertionSchema = v.object({
	kind: v.literal("regex"),
	pattern: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_ASSERTION_PATTERN)),
	flags: v.optional(v.pipe(v.string(), v.regex(/^[gimsuy]*$/), v.maxLength(8)), ""),
});

const EqualsAssertionSchema = v.object({
	kind: v.literal("equals"),
	text: v.pipe(v.string(), v.maxLength(MAX_ASSERTION_TEXT)),
	case_insensitive: v.optional(v.boolean(), true),
	trim: v.optional(v.boolean(), true),
});

const ToolCalledAssertionSchema = v.object({
	kind: v.literal("tool_called"),
	name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
});

const ToolNotCalledAssertionSchema = v.object({
	kind: v.literal("tool_not_called"),
	name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
});

const ToolArgsMatchAssertionSchema = v.object({
	kind: v.literal("tool_args_match"),
	name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
	// Deep-partial match against the recorded `args_json` for the matching
	// tool call. JSON-object only — primitive top-level args don't fit this
	// assertion shape; use a regex against the recorded JSON if needed.
	args: v.record(v.string(), v.unknown()),
});

const MaxLatencyAssertionSchema = v.object({
	kind: v.literal("max_latency_ms"),
	max_ms: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const MaxTtftAssertionSchema = v.object({
	kind: v.literal("max_ttft_ms"),
	max_ms: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/**
 * Declarative assertion that the server runs against one turn of a replay.
 * Closed catalog — every variant is dispatched exhaustively in
 * `evaluateAssertion` via `ts-pattern`'s `.exhaustive()`. Adding a new
 * variant requires: a new variant schema, a new arm in the dispatcher, and
 * tests for both.
 */
export const AssertionSchema = v.variant("kind", [
	ContainsAssertionSchema,
	NotContainsAssertionSchema,
	RegexAssertionSchema,
	EqualsAssertionSchema,
	ToolCalledAssertionSchema,
	ToolNotCalledAssertionSchema,
	ToolArgsMatchAssertionSchema,
	MaxLatencyAssertionSchema,
	MaxTtftAssertionSchema,
]);
export type Assertion = v.InferOutput<typeof AssertionSchema>;
export type AssertionKind = Assertion["kind"];

export const AssertionsArraySchema = v.pipe(
	v.array(AssertionSchema),
	v.maxLength(MAX_ASSERTIONS_PER_TURN),
);

/**
 * Inputs to `evaluateAssertion`. The evaluator is pure — every byte it
 * needs to render a verdict is on this struct.
 *
 * `transcript` is null when the transcription stage failed for this turn
 * — every text-based assertion variant maps that to `status: "errored"`
 * with a stable message, rather than asserting against an empty string.
 *
 * `toolCalls` / `modelUsage` arrive pre-filtered to this turn by the caller
 * — membership is the audio-timeline window `[turnStartMs, turnEndMs)`
 * computed in the evaluate-replay stage (see `src/server/replays/timeline.ts`),
 * not a stored `turn_idx`.
 *
 * `hasRecordingAnchor` is false when the replay has no `recording_started_at`
 * (older SDK). Without it, span `started_at` can't be mapped onto the audio
 * timeline, so tool-presence and ttft assertions can't be attributed to a
 * turn — they map to `errored`, never a misleading pass/fail.
 *
 * `metrics.ttftMs` is the earliest in-window model call's
 * `model_usage.ttft_ms` (or null), NOT a per-turn aggregate.
 */
export interface AssertionContext {
	readonly turnIdx: number;
	readonly turnRole: TurnRole;
	readonly transcript: string | null;
	readonly hasRecordingAnchor: boolean;
	readonly toolCalls: readonly ToolCallRow[];
	readonly modelUsage: readonly ModelUsageRow[];
	readonly metrics: {
		readonly agentResponseMs: number | null;
		readonly ttftMs: number | null;
	};
}

export interface AssertionOutcome {
	readonly status: "passed" | "failed" | "errored";
	readonly message: string | null;
}
