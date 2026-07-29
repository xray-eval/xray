import * as v from "valibot";

import { AssertionsArraySchema } from "@/server/assertions/assertions.types.ts";
import { JudgeSchema, JudgesArraySchema } from "@/server/judges/judges.types.ts";

// Cap for the JSON `spec` part — the multipart audio file parts have their own
// much larger cap (MAX_AUDIO_BYTES). 256 KB covers a 100-turn script with long
// text and KB of overhead with orders of magnitude of headroom.
export const MAX_CONVERSATION_BODY_BYTES = 256 * 1024;
export const MAX_CONVERSATION_NAME = 256;
export const MAX_TURNS_PER_CONVERSATION = 1024;
const MAX_TURN_TEXT = 64 * 1024;
const MAX_TURN_KEY = 128;
const MAX_AUDIO_VOICE_ID = 1024;
const MAX_UPLOAD_KEY = 128;
export const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
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

// Lowercase language tag, primary subtag + optional region (`de`, `en_us`) —
// matches the tag format of Mistral's voice catalog. TTS providers with
// language-specific voices use it to pick a default voice for the turn.
const TurnLanguageSchema = v.pipe(
	v.string(),
	v.regex(/^[a-z]{2,3}(_[a-z]{2})?$/, 'Must be a lowercase language tag like "de" or "en_us"'),
);

// Milliseconds into the preceding agent turn's speech at which the user barges
// in. Measured from agent speech onset (not turn start) so the cut lands at the
// same point run-to-run regardless of response latency; ≥1 because 0 ms would
// interrupt before the agent makes a sound.
const InterruptAfterMsSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

// How long an agent turn must stay silent before the driver treats it as over,
// overriding the runtime default. Driver-side pacing the server never executes —
// it rides the wire because it changes what the recording contains (a turn that
// waits out a tool round-trip captures the answer; one that doesn't, doesn't),
// which makes it part of the test identity. ≥1 because 0 would end the turn the
// instant the agent made a sound.
const QuietPeriodMsSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const TtsAudioUploadSchema = v.object({
	kind: v.literal("tts"),
	voice_id: v.optional(v.pipe(v.string(), v.maxLength(MAX_AUDIO_VOICE_ID))),
	language: v.optional(TurnLanguageSchema),
});

// A `RecordedAudio` turn references a multipart file part by `upload_key`, not
// a filesystem path: the dev's local path deliberately doesn't ride the wire —
// it would make the conversation hash machine-local.
const RecordedAudioUploadSchema = v.object({
	kind: v.literal("recorded"),
	upload_key: v.pipe(
		v.string(),
		v.nonEmpty(),
		v.maxLength(MAX_UPLOAD_KEY),
		v.regex(UPLOAD_KEY_RE, "upload_key may only contain [A-Za-z0-9_.-]"),
	),
});

const TurnAudioUploadSchema = v.variant("kind", [RecordedAudioUploadSchema, TtsAudioUploadSchema]);

/** One turn as it arrives in the request body — audio carries `upload_key`,
 *  not the canonical `sha256`. */
export const ConversationTurnRequestSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioUploadSchema),
	interrupt_after_ms: v.optional(InterruptAfterMsSchema),
	quiet_period_ms: v.optional(QuietPeriodMsSchema),
	assertions: v.optional(AssertionsArraySchema, []),
});
export type ConversationTurnRequest = v.InferOutput<typeof ConversationTurnRequestSchema>;

// No array-level `minLength`: a `live` session upserts an empty-turn spec
// (turns observed at runtime, not scripted). The "≥1 turn" rule for scripted
// conversations is enforced at the request-object level below, gated on `live`.
export const TurnsRequestArraySchema = v.pipe(
	v.array(ConversationTurnRequestSchema),
	v.maxLength(MAX_TURNS_PER_CONVERSATION),
);

/**
 * JSON `spec` part of `POST /v1/conversations` (multipart/form-data): the
 * display label + request-form turns. `live === true` allows an empty `turns`
 * array (a mic session has no script) and salts the hash so each live POST
 * mints a fresh conversation row (see canonicalizeAndHashSpec).
 */
export const CreateConversationRequestSchema = v.pipe(
	v.object({
		name: ConversationNameSchema,
		turns: TurnsRequestArraySchema,
		// Conversation-level judges, run once per replay against the full
		// transcript. Part of the test identity: adding/removing/reordering
		// them changes the conversation hash.
		judges: v.optional(JudgesArraySchema, []),
		live: v.optional(v.boolean(), false),
	}),
	v.check(
		(input) => input.live || input.turns.length >= 1,
		"A non-live conversation must declare at least one turn",
	),
	v.check(
		(input) => input.turns.every(isInterruptPlacementValid),
		"interrupt_after_ms is only valid on a user turn that immediately follows an agent turn",
	),
	v.check(
		(input) =>
			input.turns.every((turn) => turn.quiet_period_ms === undefined || turn.role === "agent"),
		"quiet_period_ms is only valid on an agent turn",
	),
);
export type CreateConversationRequest = v.InferOutput<typeof CreateConversationRequestSchema>;

// A turn only earns an `interrupt_after_ms` if it's a user turn cutting into
// the agent turn right before it — there's nothing to barge in on otherwise
// (a first turn, or a turn preceded by another user turn).
function isInterruptPlacementValid(
	turn: ConversationTurnRequest,
	index: number,
	turns: readonly ConversationTurnRequest[],
): boolean {
	if (turn.interrupt_after_ms === undefined) return true;
	return turn.role === "user" && turns[index - 1]?.role === "agent";
}

const RecordedAudioRefSchema = v.object({
	kind: v.literal("recorded"),
	sha256: ConversationHashSchema,
});

// Canonical form folds the *generated bytes'* sha256 into the hash — generated
// audio is part of the test identity, exactly like recorded audio. Determinism
// across re-POSTs comes from the `tts_synth_cache` fingerprint index, not the
// (non-deterministic) synthesis itself.
const TtsAudioRefSchema = v.object({
	kind: v.literal("tts"),
	sha256: ConversationHashSchema,
	voice_id: v.optional(v.pipe(v.string(), v.maxLength(MAX_AUDIO_VOICE_ID))),
	language: v.optional(TurnLanguageSchema),
});

const TurnAudioRefSchema = v.variant("kind", [RecordedAudioRefSchema, TtsAudioRefSchema]);
export type TurnAudioRef = v.InferOutput<typeof TurnAudioRefSchema>;

/** Canonical/stored form of one turn (in `conversations.turns_json`, the input
 *  to the conversation hash). `assertions` is included because the test
 *  identity must change when its checks change — same turns + different
 *  assertions = different test. */
export const ConversationTurnSchema = v.object({
	role: TurnRoleSchema,
	text: v.optional(v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT))),
	key: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TURN_KEY))),
	audio: v.optional(TurnAudioRefSchema),
	// Part of the canonical form (and thus the hash) because scripting a
	// barge-in changes the test: the user now cuts in mid-response instead of
	// waiting for the agent to finish. Default-less optional so a turn that
	// doesn't interrupt omits the key entirely, leaving every existing
	// conversation's hash byte-for-byte unchanged.
	interrupt_after_ms: v.optional(InterruptAfterMsSchema),
	// Canonical for the same reason as interrupt_after_ms: it changes what the
	// run records, so it changes the test. Default-less optional so turns on the
	// runtime default omit the key and every existing hash stays byte-identical.
	quiet_period_ms: v.optional(QuietPeriodMsSchema),
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
 * Canonical spec stored in `conversations.turns_json` — the turn array +
 * judges wrapped in one object so the single column carries both. The column
 * name predates judges; the *contents* are the full spec.
 *
 * `live_salt` (a server-generated UUID) is folded into the canonical JSON so
 * two live sessions with identical empty turns still hash to distinct rows.
 * Both `live` and `live_salt` are absent on scripted conversations.
 */
export const StoredConversationSpecSchema = v.object({
	turns: TurnsArraySchema,
	judges: v.optional(v.array(JudgeSchema), []),
	live: v.optional(v.boolean(), false),
	live_salt: v.optional(v.string()),
});
export type StoredConversationSpec = v.InferOutput<typeof StoredConversationSpecSchema>;

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
