import * as v from "valibot";

import { AssertionsArraySchema } from "@/server/assertions/assertions.types.ts";
import { JudgeSchema, JudgesArraySchema } from "@/server/judges/judges.types.ts";

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
 *  `upload_key` pointing at a multipart file part. `assertions` declares
 *  what the server should check against this turn's transcript / tool calls
 *  / metrics after the run completes. */
export const ConversationTurnRequestSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioUploadSchema),
	assertions: v.optional(AssertionsArraySchema, []),
});
export type ConversationTurnRequest = v.InferOutput<typeof ConversationTurnRequestSchema>;

// No array-level `minLength` here: a `live` session upserts an empty-turn
// spec (its turns are observed at runtime, not scripted). The "at least one
// turn" rule for ordinary scripted conversations is enforced at the
// request-object level below, gated on `live === false`.
export const TurnsRequestArraySchema = v.pipe(
	v.array(ConversationTurnRequestSchema),
	v.maxLength(MAX_TURNS_PER_CONVERSATION),
);

/**
 * JSON `spec` part of `POST /v1/conversations` (multipart/form-data).
 * Carries the dev-facing display label + the turn array (in request form);
 * `RecordedAudio` turns reference multipart file parts by `upload_key`.
 * Server reads each audio file part, sha256s the bytes, stores a
 * content-addressed copy, substitutes the sha256 into the canonical form,
 * then hashes the canonical turn JSON to produce the conversation hash.
 *
 * `live`: a live mic session has no script. The server allows an empty
 * `turns` array when `live === true` and salts the hash so each live POST
 * mints a fresh conversation row (see canonicalizeAndHashSpec).
 */
export const CreateConversationRequestSchema = v.pipe(
	v.object({
		name: ConversationNameSchema,
		turns: TurnsRequestArraySchema,
		// Conversation-level judges. Run once per replay against the full
		// transcript by the evaluate-replay job. Adding/removing/reordering
		// judges changes the conversation hash — judges are part of the test
		// identity, not metadata.
		judges: v.optional(JudgesArraySchema, []),
		live: v.optional(v.boolean(), false),
	}),
	v.check(
		(input) => input.live || input.turns.length >= 1,
		"A non-live conversation must declare at least one turn",
	),
);
export type CreateConversationRequest = v.InferOutput<typeof CreateConversationRequestSchema>;

// ─── Canonical-form schemas (what's hashed, stored, and returned) ─────

const RecordedAudioRefSchema = v.object({
	kind: v.literal("recorded"),
	sha256: ConversationHashSchema,
});

const TurnAudioRefSchema = v.variant("kind", [RecordedAudioRefSchema, TtsAudioRefSchema]);

/** Canonical/stored form of one turn. Lives in `conversations.turns_json` and
 *  is the input to the conversation hash. `assertions` is part of the
 *  canonical form because the test identity must change when its checks
 *  change — same turn structure + different assertions = different test. */
export const ConversationTurnSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioRefSchema),
	assertions: v.optional(AssertionsArraySchema, []),
});
export type ConversationTurn = v.InferOutput<typeof ConversationTurnSchema>;

// Stored turns may be empty for a `live` conversation; non-live specs always
// arrive with ≥1 turn because the request schema's object-level check
// enforced it before the spec was canonicalized and stored.
export const TurnsArraySchema = v.pipe(
	v.array(ConversationTurnSchema),
	v.maxLength(MAX_TURNS_PER_CONVERSATION),
);

/**
 * Canonical conversation spec stored in `conversations.turns_json`. Wraps
 * the turn array + the conversation-level judges into one object so the
 * single `turns_json` column can carry both. The column name predates
 * judges; the *contents* are the full spec.
 *
 * `live` marks a mic session; `live_salt` is a server-generated UUID folded
 * into the canonical JSON so two live sessions with identical (empty) turns
 * still hash to distinct conversation rows. Both are absent on ordinary
 * scripted conversations.
 */
export const StoredConversationSpecSchema = v.object({
	turns: TurnsArraySchema,
	judges: v.optional(v.array(JudgeSchema), []),
	live: v.optional(v.boolean(), false),
	live_salt: v.optional(v.string()),
});
export type StoredConversationSpec = v.InferOutput<typeof StoredConversationSpecSchema>;

/** Response of `GET /v1/conversations/:hash`. */
export const ConversationResponseSchema = v.object({
	hash: v.string(),
	name: v.string(),
	created_at: v.string(),
	last_run_at: v.nullable(v.string()),
	turns: v.array(ConversationTurnSchema),
	judges: v.array(JudgeSchema),
	live: v.boolean(),
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
