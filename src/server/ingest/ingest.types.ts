import * as v from "valibot";

// The session id lives in the URL path, never in the body — retries are
// idempotent on the URL alone.
//
// Every timestamp is normalized to UTC ISO 8601 (`Z` suffix) at the boundary:
// SQLite TEXT comparison only matches chronological order when every value is
// in the same timezone. Without the transform, a `+09:00`-offset timestamp
// would lex-sort wrong against a `Z` timestamp and break `listSessions`
// ordering and the MIN-merge invariant in `sessions-repo.saveSession`.

const MAX_AGENT_ID = 256;
export const MAX_TOOL_NAME = 256;
/** Generous: ~10K words of transcript per turn covers any plausible call. */
export const MAX_TURN_TEXT = 64 * 1024;
const MAX_TURN_IDX = 1_000_000;
/** Seven days in ms — durationMs and per-call latencies can't plausibly exceed this. */
export const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export const RoleSchema = v.picklist(["user", "agent", "tool", "system"]);
const IsoTimestampSchema = v.pipe(
	v.string(),
	v.isoTimestamp(),
	// `new Date(s).toISOString()` produces `YYYY-MM-DDTHH:mm:ss.sssZ`, so two
	// inputs in different timezones compare correctly as TEXT after this hop.
	v.transform((s) => new Date(s).toISOString()),
);
const NonNegativeIntSchema = v.pipe(
	v.number(),
	v.integer(),
	v.minValue(0),
	v.maxValue(MAX_TURN_IDX),
);
const NonNegativeDurationMsSchema = v.pipe(
	v.number(),
	v.integer(),
	v.minValue(0),
	v.maxValue(MAX_DURATION_MS),
);

export const SessionStartedEventSchema = v.object({
	type: v.literal("session_started"),
	agentId: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_AGENT_ID)),
	startedAt: IsoTimestampSchema,
});
export type SessionStartedEvent = v.InferOutput<typeof SessionStartedEventSchema>;

export const TurnCompletedEventSchema = v.object({
	type: v.literal("turn_completed"),
	idx: NonNegativeIntSchema,
	role: RoleSchema,
	text: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
	timestamp: IsoTimestampSchema,
	responseLatencyMs: v.optional(NonNegativeDurationMsSchema),
	interrupted: v.optional(v.boolean()),
	interruptedAtMs: v.optional(NonNegativeDurationMsSchema),
});
export type TurnCompletedEvent = v.InferOutput<typeof TurnCompletedEventSchema>;

export const ToolCalledEventSchema = v.object({
	type: v.literal("tool_called"),
	turnIdx: NonNegativeIntSchema,
	idx: NonNegativeIntSchema,
	name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
	args: v.unknown(),
	result: v.optional(v.unknown()),
	latencyMs: v.optional(NonNegativeDurationMsSchema),
});
export type ToolCalledEvent = v.InferOutput<typeof ToolCalledEventSchema>;

export const SessionEndedEventSchema = v.object({
	type: v.literal("session_ended"),
	endedAt: IsoTimestampSchema,
	durationMs: NonNegativeDurationMsSchema,
});
export type SessionEndedEvent = v.InferOutput<typeof SessionEndedEventSchema>;

export const IngestEventSchema = v.variant("type", [
	SessionStartedEventSchema,
	TurnCompletedEventSchema,
	ToolCalledEventSchema,
	SessionEndedEventSchema,
]);
export type IngestEvent = v.InferOutput<typeof IngestEventSchema>;

/**
 * Path-parameter id schema. The string lives in the URL, so it never crosses
 * the request body validation step; the router calls this separately.
 *
 * Charset is intentionally narrow: anything the inspector UI might render
 * (HTML, control chars, whitespace) stays out of the primary key.
 */
const MAX_SESSION_ID = 128;
export const SessionIdSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(MAX_SESSION_ID),
	v.regex(/^[A-Za-z0-9._-]+$/),
	// Defense in depth for any consumer that joins the id into a filesystem
	// path (e.g. the audio slice). URL normalization currently strips `..`
	// before route matching, but enforcing it at the schema means a non-HTTP
	// caller can't bypass it.
	v.check(
		(s) => s !== "." && s !== ".." && !s.includes(".."),
		"session id cannot be '.', '..', or contain '..'",
	),
);
