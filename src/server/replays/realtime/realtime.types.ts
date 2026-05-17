import * as v from "valibot";

import { AudioContentTypeSchema } from "@/server/audio/audio.types.ts";
import {
	MAX_DURATION_MS,
	MAX_TOOL_NAME,
	MAX_TURN_TEXT,
	RoleSchema,
	SessionIdSchema,
} from "@/server/ingest/ingest.types.ts";

/**
 * Wire shapes for the realtime (V2V) replay protocol.
 *
 * The xray engine opens ONE WebSocket per replay run to the user's webhook,
 * sends recorded user audio chunk-by-chunk, and consumes the agent's response
 * audio + transcript framed by turn boundaries. The webhook is the part that
 * speaks to OpenAI Realtime (or any other voice-to-voice provider) — xray
 * stays format-agnostic so a future Google Live / Gemini Live webhook can
 * implement the same envelope without changing xray.
 *
 * This is `protocolVersion: 1`. Bumping the major means a breaking change to
 * any of the frames below; the engine refuses to talk to a webhook whose
 * server.hello declares a different major.
 */

const WS_URL_SCHEMES = new Set(["ws:", "wss:"]);
const MAX_WEBHOOK_URL = 2048;
const MAX_PROTOCOL_ERROR_MESSAGE = 1024;
const MAX_AUDIO_CHUNK_BYTES = 1_500_000;
const MAX_TURNS_PER_SESSION = 1024;
const MAX_TOOL_CALLS_PER_TURN = 64;
const MAX_RECORDED_TOOLS_PER_TURN = 64;
const MAX_BASE64_PER_CHUNK = Math.ceil((MAX_AUDIO_CHUNK_BYTES * 4) / 3) + 4;
/** Per-turn agent audio cap. 32 MB is ~10 minutes of PCM16/24 kHz mono
 *  (24000 * 2 * 600 ≈ 28 MB) with headroom — past the realistic single-turn
 *  budget for any voice-agent provider. A webhook that exceeds it is
 *  misbehaving and the engine throws `AgentTurnTooLargeError` instead of
 *  growing the heap unbounded. */
const MAX_AGENT_AUDIO_BYTES_PER_TURN = 32 * 1024 * 1024;

/** Used everywhere a frame references a turn index — one source of truth. */
const TurnIdxSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const LatencyMsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DURATION_MS));

export const REALTIME_REPLAY_PROTOCOL_VERSION = 1;

/**
 * Body of `POST /v1/replays/realtime`. Same shape as the text replay request
 * except the URL must be `ws:` or `wss:` — http(s) is rejected at the
 * boundary so the engine cannot accidentally open a long-polled HTTP socket
 * to a misconfigured webhook.
 */
export const CreateRealtimeReplayRequestSchema = v.object({
	sourceSessionId: SessionIdSchema,
	webhookUrl: v.pipe(
		v.string(),
		v.url(),
		v.maxLength(MAX_WEBHOOK_URL),
		v.check((u) => {
			try {
				return WS_URL_SCHEMES.has(new URL(u).protocol);
			} catch {
				return false;
			}
		}, "Webhook URL must use ws or wss"),
	),
});
export type CreateRealtimeReplayRequest = v.InferOutput<typeof CreateRealtimeReplayRequestSchema>;

/**
 * One recorded tool result from the source session, attached to the manifest
 * entry for the agent turn that produced it. Same shape as the text replay
 * webhook contract so a contributor running both webhooks recognizes it.
 */
export const RecordedToolResultSchema = v.object({
	name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
	args: v.unknown(),
	result: v.unknown(),
});
export type RecordedToolResult = v.InferOutput<typeof RecordedToolResultSchema>;

/**
 * Manifest entry sent in the session.start frame — one per source turn,
 * in order, so the webhook can plan its OpenAI Realtime `session.update`
 * before audio chunks start arriving. Agent turns carry the source's tool
 * calls so the webhook can satisfy the model's function-call attempts with
 * the recorded result instead of executing real tools (which would change
 * the run between replays).
 */
export const TurnManifestEntrySchema = v.object({
	turnIdx: TurnIdxSchema,
	role: RoleSchema,
	/** Source-session transcript text — gives the webhook context without needing a separate fetch. */
	text: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
	/** Null when the source turn has no recorded audio (text-only ingest). */
	audioContentType: v.nullable(AudioContentTypeSchema),
	/** Empty for user/tool/system turns. Present only on agent turns. */
	recordedToolResults: v.pipe(
		v.array(RecordedToolResultSchema),
		v.maxLength(MAX_RECORDED_TOOLS_PER_TURN),
	),
});
export type TurnManifestEntry = v.InferOutput<typeof TurnManifestEntrySchema>;

const SessionStartFrameSchema = v.object({
	type: v.literal("session.start"),
	protocolVersion: v.literal(REALTIME_REPLAY_PROTOCOL_VERSION),
	sourceSessionId: SessionIdSchema,
	targetSessionId: SessionIdSchema,
	turns: v.pipe(v.array(TurnManifestEntrySchema), v.maxLength(MAX_TURNS_PER_SESSION)),
});

const UserAudioAppendFrameSchema = v.object({
	type: v.literal("user_audio.append"),
	turnIdx: TurnIdxSchema,
	/** Base64-encoded audio chunk. Capped per-chunk so a malicious or buggy
	 *  caller can't OOM the receiver with one giant frame. */
	audioBase64: v.pipe(v.string(), v.maxLength(MAX_BASE64_PER_CHUNK)),
});

const UserAudioCommitFrameSchema = v.object({
	type: v.literal("user_audio.commit"),
	turnIdx: TurnIdxSchema,
});

const SessionEndFrameSchema = v.object({
	type: v.literal("session.end"),
});

/** Frames the xray engine sends INTO the webhook. */
export const ClientFrameSchema = v.variant("type", [
	SessionStartFrameSchema,
	UserAudioAppendFrameSchema,
	UserAudioCommitFrameSchema,
	SessionEndFrameSchema,
]);
export type ClientFrame = v.InferOutput<typeof ClientFrameSchema>;

const AgentAudioDeltaFrameSchema = v.object({
	type: v.literal("agent_audio.delta"),
	turnIdx: TurnIdxSchema,
	audioBase64: v.pipe(v.string(), v.maxLength(MAX_BASE64_PER_CHUNK)),
	/** Identifies how to file the bytes — chunks within one turn MUST share
	 *  the same contentType. The engine rejects mid-turn changes. */
	contentType: AudioContentTypeSchema,
});

const AgentTranscriptDeltaFrameSchema = v.object({
	type: v.literal("agent_transcript.delta"),
	turnIdx: TurnIdxSchema,
	text: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
});

/**
 * One tool the agent invoked during this turn. Sent BEFORE the turn.done
 * frame for the same turnIdx. The webhook has already satisfied the call
 * with the recorded result (from the manifest) and continued the response —
 * xray records this as an after-the-fact observation in the target session.
 */
const ToolCalledFrameSchema = v.object({
	type: v.literal("tool_called"),
	turnIdx: TurnIdxSchema,
	idx: TurnIdxSchema,
	name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_TOOL_NAME)),
	args: v.unknown(),
	/**
	 * Optional. When the webhook injected a recorded result, echoing it back
	 * makes the target session's tool history a complete round-trip — the diff
	 * view can compare arg shapes against the source without a join.
	 */
	result: v.optional(v.unknown()),
	latencyMs: v.optional(LatencyMsSchema),
});

const TurnDoneFrameSchema = v.object({
	type: v.literal("turn.done"),
	turnIdx: TurnIdxSchema,
	/** Final agent transcript for this turn — authoritative; deltas were optional progress UI. */
	transcript: v.pipe(v.string(), v.maxLength(MAX_TURN_TEXT)),
	responseLatencyMs: v.optional(LatencyMsSchema),
	interrupted: v.optional(v.boolean()),
});

/** A typed error from the webhook — the engine writes its message into the run's `error` field. */
const ProtocolErrorFrameSchema = v.object({
	type: v.literal("error"),
	code: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
	message: v.pipe(v.string(), v.maxLength(MAX_PROTOCOL_ERROR_MESSAGE)),
});

/** Frames the webhook sends BACK to the xray engine. */
export const ServerFrameSchema = v.variant("type", [
	AgentAudioDeltaFrameSchema,
	AgentTranscriptDeltaFrameSchema,
	ToolCalledFrameSchema,
	TurnDoneFrameSchema,
	ProtocolErrorFrameSchema,
]);
export type ServerFrame = v.InferOutput<typeof ServerFrameSchema>;

/** Re-exported so the engine and tests share one chunk cap. */
export const MAX_REALTIME_AUDIO_CHUNK_BYTES = MAX_AUDIO_CHUNK_BYTES;
export const MAX_REALTIME_TOOL_CALLS_PER_TURN = MAX_TOOL_CALLS_PER_TURN;
export const MAX_REALTIME_AGENT_AUDIO_BYTES_PER_TURN = MAX_AGENT_AUDIO_BYTES_PER_TURN;
