import * as v from "valibot";

// The session id lives in the URL path, never in the body — retries are
// idempotent on the URL alone.

const RoleSchema = v.picklist(["user", "agent", "tool", "system"]);

export const SessionStartedEventSchema = v.object({
	type: v.literal("session_started"),
	agentId: v.string(),
	startedAt: v.string(),
	workflow: v.optional(v.unknown()),
	metadata: v.optional(v.record(v.string(), v.unknown())),
});
export type SessionStartedEvent = v.InferOutput<typeof SessionStartedEventSchema>;

export const TurnCompletedEventSchema = v.object({
	type: v.literal("turn_completed"),
	idx: v.pipe(v.number(), v.integer(), v.minValue(0)),
	role: RoleSchema,
	text: v.string(),
	timestamp: v.string(),
	llmLatencyMs: v.optional(v.pipe(v.number(), v.minValue(0))),
});
export type TurnCompletedEvent = v.InferOutput<typeof TurnCompletedEventSchema>;

export const ToolCalledEventSchema = v.object({
	type: v.literal("tool_called"),
	turnIdx: v.pipe(v.number(), v.integer(), v.minValue(0)),
	name: v.string(),
	args: v.unknown(),
	result: v.optional(v.unknown()),
	latencyMs: v.optional(v.pipe(v.number(), v.minValue(0))),
});
export type ToolCalledEvent = v.InferOutput<typeof ToolCalledEventSchema>;

export const SessionEndedEventSchema = v.object({
	type: v.literal("session_ended"),
	endedAt: v.string(),
	durationMs: v.pipe(v.number(), v.minValue(0)),
});
export type SessionEndedEvent = v.InferOutput<typeof SessionEndedEventSchema>;

export const IngestEventSchema = v.variant("type", [
	SessionStartedEventSchema,
	TurnCompletedEventSchema,
	ToolCalledEventSchema,
	SessionEndedEventSchema,
]);
export type IngestEvent = v.InferOutput<typeof IngestEventSchema>;
