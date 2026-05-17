import type { BaseIssue } from "valibot";

/** Base class for every error thrown by the realtime replay transport. */
export class RealtimeReplayError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RealtimeReplayError";
	}
}

/** `POST /v1/replays/realtime` body failed Valibot validation. */
export class InvalidRealtimeReplayRequestError extends RealtimeReplayError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Invalid POST /v1/replays/realtime body");
		this.name = "InvalidRealtimeReplayRequestError";
		this.issues = issues;
	}
}

/** WS handshake to the webhook failed (DNS, refused, TLS, HTTP error pre-upgrade).
 *  The URL is held on the structured field; we deliberately keep it OUT of
 *  the message so a webhook URL carrying an auth token in its query string
 *  (acknowledged as a real pattern in the modal) can't leak into the
 *  `replay_runs.error` SQLite column, the public `GET /v1/replays/:id`
 *  response, or container stdout. */
export class WebhookConnectError extends RealtimeReplayError {
	readonly webhookUrl: string;

	constructor(webhookUrl: string, message: string, options?: ErrorOptions) {
		super(`Failed to open WebSocket to webhook: ${message}`, options);
		this.name = "WebhookConnectError";
		this.webhookUrl = webhookUrl;
	}
}

/** WS closed before the engine saw the expected number of `turn.done` frames. */
export class WebhookClosedEarlyError extends RealtimeReplayError {
	readonly turnsCompleted: number;
	readonly turnsExpected: number;
	readonly code: number;
	readonly reason: string;

	constructor(turnsCompleted: number, turnsExpected: number, code: number, reason: string) {
		super(
			`WebSocket closed (code=${code}) after ${turnsCompleted}/${turnsExpected} turns: ${reason || "(no reason)"}`,
		);
		this.name = "WebhookClosedEarlyError";
		this.turnsCompleted = turnsCompleted;
		this.turnsExpected = turnsExpected;
		this.code = code;
		this.reason = reason;
	}
}

/** A frame the webhook sent failed `ServerFrameSchema`. */
export class WebhookInvalidFrameError extends RealtimeReplayError {
	readonly issues: readonly BaseIssue<unknown>[];

	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Webhook sent a frame that did not match ServerFrameSchema");
		this.name = "WebhookInvalidFrameError";
		this.issues = issues;
	}
}

/** A frame arrived that wasn't valid JSON (or wasn't a string at all). */
export class WebhookMalformedFrameError extends RealtimeReplayError {
	constructor(options?: ErrorOptions) {
		super("Webhook sent a frame that was not valid JSON text", options);
		this.name = "WebhookMalformedFrameError";
	}
}

/** Webhook sent an error frame; the message is surfaced to the operator via the run row. */
export class WebhookReportedError extends RealtimeReplayError {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`Webhook reported "${code}": ${message}`);
		this.name = "WebhookReportedError";
		this.code = code;
	}
}

/** Webhook sent frames for a turn idx that isn't in the source manifest. */
export class UnknownTurnIdxError extends RealtimeReplayError {
	readonly turnIdx: number;

	constructor(turnIdx: number) {
		super(`Webhook referenced turn idx ${turnIdx} which is not in the source session`);
		this.name = "UnknownTurnIdxError";
		this.turnIdx = turnIdx;
	}
}

/** Audio chunks within one turn switched content type mid-stream. */
export class ContentTypeChangedMidTurnError extends RealtimeReplayError {
	readonly turnIdx: number;
	readonly first: string;
	readonly conflicting: string;

	constructor(turnIdx: number, first: string, conflicting: string) {
		super(
			`Turn ${turnIdx} agent_audio.delta chunks switched content type from "${first}" to "${conflicting}"`,
		);
		this.name = "ContentTypeChangedMidTurnError";
		this.turnIdx = turnIdx;
		this.first = first;
		this.conflicting = conflicting;
	}
}

/** A turn's `agent_audio.delta` chunks exceeded the per-turn byte cap before
 *  `turn.done` arrived — a webhook that streams audio forever would OOM the
 *  engine and fill the audio volume; the cap stops it. */
export class AgentTurnTooLargeError extends RealtimeReplayError {
	readonly turnIdx: number;
	readonly bytes: number;
	readonly limit: number;

	constructor(turnIdx: number, bytes: number, limit: number) {
		super(
			`Turn ${turnIdx} agent_audio exceeded the per-turn cap (${bytes} > ${limit} bytes) before turn.done`,
		);
		this.name = "AgentTurnTooLargeError";
		this.turnIdx = turnIdx;
		this.bytes = bytes;
		this.limit = limit;
	}
}

/** A turn's `tool_called` frame count exceeded the per-turn cap before
 *  `turn.done` arrived. The cap exists as `MAX_REALTIME_TOOL_CALLS_PER_TURN`;
 *  this error is what fires when a webhook tries to exceed it. */
export class TooManyToolCallsError extends RealtimeReplayError {
	readonly turnIdx: number;
	readonly limit: number;

	constructor(turnIdx: number, limit: number) {
		super(`Turn ${turnIdx} sent more than ${limit} tool_called frames before turn.done`);
		this.name = "TooManyToolCallsError";
		this.turnIdx = turnIdx;
		this.limit = limit;
	}
}

/** An `audio_path` column carries an extension we don't know how to map back
 *  to a content type. Indicates store corruption from a hand-edit — the
 *  audio writer only ever stamps known extensions. */
export class UnknownAudioExtensionError extends RealtimeReplayError {
	readonly extension: string;
	readonly path: string;

	constructor(extension: string, path: string) {
		super(`Unknown audio extension "${extension}" in path "${path}"`);
		this.name = "UnknownAudioExtensionError";
		this.extension = extension;
		this.path = path;
	}
}
