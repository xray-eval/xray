import * as v from "valibot";

// Caps for the JSON `spec` part of POST /v1/replays — the multipart body's
// raw audio file parts have their own much larger cap (see MAX_AUDIO_BYTES).
// A 100-turn script with long text and a few KB of overhead is the worst
// realistic case; 256 KB covers it with three orders of magnitude of headroom.
export const MAX_CONVERSATION_BODY_BYTES = 256 * 1024;
export const MAX_CONVERSATION_NAME = 256;
export const MAX_TURNS_PER_CONVERSATION = 1024;
const MAX_TURN_TEXT = 64 * 1024;
const MAX_TURN_KEY = 128;
const MAX_AUDIO_VOICE_ID = 1024;
const MAX_UPLOAD_KEY = 128;
/** Shared validator: 64-char lowercase hex SHA-256. */
export const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
/** Multipart file-part field name referenced from a `RecordedAudio` turn. */
const UPLOAD_KEY_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Conversation hash — full SHA-256 hex over the canonical-JSON encoding of
 * the turn array (including per-turn `RecordedAudio` byte sha256). Computed
 * server-side from the multipart file parts; the SDK never hashes anything.
 */
export const ConversationHashSchema = v.pipe(
	v.string(),
	v.regex(HEX_SHA256_RE, "Must be a 64-char lowercase hex SHA-256"),
);
export type ConversationHash = v.InferOutput<typeof ConversationHashSchema>;

export const ConversationNameSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(MAX_CONVERSATION_NAME),
);

const TurnRoleSchema = v.picklist(["user", "agent"]);

const TtsAudioRefSchema = v.object({
	kind: v.literal("tts"),
	voice_id: v.optional(v.pipe(v.string(), v.maxLength(MAX_AUDIO_VOICE_ID))),
});

// ─── Request-form schemas (what the SDK POSTs in the `spec` part) ─────
//
// A `RecordedAudio` turn references a multipart file part by `upload_key`.
// The server reads the bytes, computes sha256, stores a content-addressed
// copy under `<audioRoot>/recorded/`, and substitutes the sha256 into the
// canonical turn before hashing. The local filesystem path the dev pointed
// at deliberately doesn't ride the wire — it would make the conversation
// hash machine-local.

const RecordedAudioUploadSchema = v.object({
	kind: v.literal("recorded"),
	upload_key: v.pipe(
		v.string(),
		v.nonEmpty(),
		v.maxLength(MAX_UPLOAD_KEY),
		v.regex(UPLOAD_KEY_RE, "upload_key may only contain [A-Za-z0-9_.-]"),
	),
});

const TurnAudioUploadSchema = v.variant("kind", [RecordedAudioUploadSchema, TtsAudioRefSchema]);

/** One step as it arrives in the request body; `RecordedAudio` carries an
 *  `upload_key` pointing at a multipart file part. */
export const ConversationTurnRequestSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioUploadSchema),
});
export type ConversationTurnRequest = v.InferOutput<typeof ConversationTurnRequestSchema>;

export const TurnsRequestArraySchema = v.pipe(
	v.array(ConversationTurnRequestSchema),
	v.minLength(1),
	v.maxLength(MAX_TURNS_PER_CONVERSATION),
);

/**
 * JSON `spec` part of `POST /v1/conversations` (multipart/form-data).
 * Carries the dev-facing display label + the turn array (in request form);
 * `RecordedAudio` turns reference multipart file parts by `upload_key`.
 * Server reads each audio file part, sha256s the bytes, stores a
 * content-addressed copy, substitutes the sha256 into the canonical form,
 * then hashes the canonical turn JSON to produce the conversation hash.
 */
export const CreateConversationRequestSchema = v.object({
	name: ConversationNameSchema,
	turns: TurnsRequestArraySchema,
});
export type CreateConversationRequest = v.InferOutput<typeof CreateConversationRequestSchema>;

// ─── Canonical-form schemas (what's hashed, stored, and returned) ─────

const RecordedAudioRefSchema = v.object({
	kind: v.literal("recorded"),
	sha256: ConversationHashSchema,
});

const TurnAudioRefSchema = v.variant("kind", [RecordedAudioRefSchema, TtsAudioRefSchema]);

/** Canonical/stored form of one turn. Lives in `conversations.turns_json` and
 *  is the input to the conversation hash. */
export const ConversationTurnSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioRefSchema),
});
export type ConversationTurn = v.InferOutput<typeof ConversationTurnSchema>;

export const TurnsArraySchema = v.pipe(
	v.array(ConversationTurnSchema),
	v.minLength(1),
	v.maxLength(MAX_TURNS_PER_CONVERSATION),
);

/** Response of `GET /v1/conversations/:hash`. */
export const ConversationResponseSchema = v.object({
	hash: v.string(),
	name: v.string(),
	created_at: v.string(),
	last_run_at: v.nullable(v.string()),
	turns: v.array(ConversationTurnSchema),
});
export type ConversationResponse = v.InferOutput<typeof ConversationResponseSchema>;

export const ConversationSummarySchema = v.object({
	hash: v.string(),
	name: v.string(),
	created_at: v.string(),
	last_run_at: v.nullable(v.string()),
	replays: v.number(),
});
export type ConversationSummary = v.InferOutput<typeof ConversationSummarySchema>;

export const ListConversationsResponseSchema = v.object({
	items: v.array(ConversationSummarySchema),
});
export type ListConversationsResponse = v.InferOutput<typeof ListConversationsResponseSchema>;
