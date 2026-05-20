import * as v from "valibot";

// Caps. Conversation specs are author-time artifacts — a 100-turn script with
// long text is the realistic worst case, plus a few KB of overhead. 256 KB
// covers the longest plausible spec with three orders of magnitude of headroom.
export const MAX_CONVERSATION_BODY_BYTES = 256 * 1024;
const MAX_CONVERSATION_ID = 128;
const MAX_CONVERSATION_VERSION = 64;
const MAX_CONVERSATION_TITLE = 256;
const MAX_TURNS_PER_CONVERSATION = 1024;
const MAX_TURN_TEXT = 64 * 1024;
const MAX_TURN_KEY = 128;
const MAX_AUDIO_PATH = 1024;

/**
 * Charset is intentionally narrow: anything the inspector UI might render
 * (HTML, control chars, whitespace) stays out of the primary key, and we
 * also guard `..` for any consumer that joins ids into a filesystem path.
 */
export const ConversationIdSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(MAX_CONVERSATION_ID),
	v.regex(/^[A-Za-z0-9._-]+$/),
	v.check(
		(s) => s !== "." && s !== ".." && !s.includes(".."),
		"conversation id cannot be '.', '..', or contain '..'",
	),
);

export const ConversationVersionSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(MAX_CONVERSATION_VERSION),
	v.regex(/^[A-Za-z0-9._-]+$/),
);

const TurnRoleSchema = v.picklist(["user", "agent"]);

const RecordedAudioRefSchema = v.object({
	kind: v.literal("recorded"),
	path: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_AUDIO_PATH)),
});

const TtsAudioRefSchema = v.object({
	kind: v.literal("tts"),
	voice_id: v.optional(v.pipe(v.string(), v.maxLength(MAX_AUDIO_PATH))),
});

const TurnAudioRefSchema = v.variant("kind", [RecordedAudioRefSchema, TtsAudioRefSchema]);

/**
 * One step in a Conversation spec. v1 supports `user` and `agent`. `agent`
 * is a placeholder turn — the agent's response is observed at runtime, not
 * pre-written. `key` is the cross-Conversation alignment join key surfaced
 * in compare views.
 */
export const ConversationTurnSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioRefSchema),
});
export type ConversationTurn = v.InferOutput<typeof ConversationTurnSchema>;

export const ConversationSpecSchema = v.object({
	id: ConversationIdSchema,
	version: ConversationVersionSchema,
	title: v.optional(v.pipe(v.string(), v.maxLength(MAX_CONVERSATION_TITLE))),
	turns: v.pipe(
		v.array(ConversationTurnSchema),
		v.minLength(1),
		v.maxLength(MAX_TURNS_PER_CONVERSATION),
	),
});
export type ConversationSpec = v.InferOutput<typeof ConversationSpecSchema>;

/** Response of `POST /v1/conversations` and `GET /v1/conversations/:id`. */
export const ConversationResponseSchema = v.object({
	id: v.string(),
	version: v.string(),
	title: v.nullable(v.string()),
	created_at: v.string(),
	turns: v.array(ConversationTurnSchema),
});
export type ConversationResponse = v.InferOutput<typeof ConversationResponseSchema>;

export const ConversationSummarySchema = v.object({
	id: v.string(),
	latest_version: v.string(),
	title: v.nullable(v.string()),
	created_at: v.string(),
	versions: v.number(),
	replays: v.number(),
});
export type ConversationSummary = v.InferOutput<typeof ConversationSummarySchema>;

export const ListConversationsResponseSchema = v.object({
	items: v.array(ConversationSummarySchema),
});
export type ListConversationsResponse = v.InferOutput<typeof ListConversationsResponseSchema>;
