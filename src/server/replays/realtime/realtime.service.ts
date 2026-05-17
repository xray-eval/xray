import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { match } from "ts-pattern";
import * as v from "valibot";

import { uploadTurnAudio } from "@/server/audio/audio.service.ts";
import type { AudioContentType } from "@/server/audio/audio.types.ts";
import { applyEvent } from "@/server/ingest/ingest.service.ts";
import {
	createReplayRow,
	errorMessage,
	groupToolCallsByTurnId,
	parseToolJson,
	runReplayWorker,
} from "@/server/replays/replays.service.ts";
import { updateReplayRunProgress } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { listToolCallsForSession } from "@/server/store/tool-calls-repo.ts";
import { deleteTurnByIdx, listTurnsForSession } from "@/server/store/turns-repo.ts";
import type { ReplayRunRow, ToolCallRow, TurnRow } from "@/server/store/types.ts";

import {
	AgentTurnTooLargeError,
	ContentTypeChangedMidTurnError,
	TooManyToolCallsError,
	UnknownAudioExtensionError,
	UnknownTurnIdxError,
	WebhookClosedEarlyError,
	WebhookConnectError,
	WebhookInvalidFrameError,
	WebhookMalformedFrameError,
	WebhookReportedError,
} from "./realtime.errors.ts";
import type {
	ClientFrame,
	CreateRealtimeReplayRequest,
	RecordedToolResult,
	ServerFrame,
	TurnManifestEntry,
} from "./realtime.types.ts";
import {
	MAX_REALTIME_AGENT_AUDIO_BYTES_PER_TURN,
	MAX_REALTIME_AUDIO_CHUNK_BYTES,
	MAX_REALTIME_TOOL_CALLS_PER_TURN,
	REALTIME_REPLAY_PROTOCOL_VERSION,
	ServerFrameSchema,
} from "./realtime.types.ts";

const EXTENSION_TO_CONTENT_TYPE: Record<string, AudioContentType> = {
	opus: "audio/opus",
	ogg: "audio/ogg",
	webm: "audio/webm",
	mp3: "audio/mp3",
	wav: "audio/wav",
};

/**
 * Insert a `replay_runs` row with `mode='realtime'` and return it. Thin
 * wrapper over the shared `createReplayRow` helper so the row shape stays
 * consistent across transports — adding a column to `replay_runs` happens
 * in one place, not two.
 */
export function createRealtimeReplay(store: Store, req: CreateRealtimeReplayRequest): ReplayRunRow {
	return createReplayRow(store, {
		sourceSessionId: req.sourceSessionId,
		webhookUrl: req.webhookUrl,
		mode: "realtime",
	});
}

/**
 * Narrowed WebSocket-client factory used by the worker. Tests stub it with a
 * connection to a `Bun.serve` mock; production passes the global `WebSocket`.
 */
export type WebSocketFactory = (url: string) => WebSocket;

export interface RunRealtimeReplayOptions {
	store: Store;
	audioRoot: string;
	runId: string;
	/** Override in tests; defaults to the global `WebSocket` constructor. */
	webSocketFactory?: WebSocketFactory;
	now?: () => string;
}

/**
 * Drive one realtime replay run end-to-end via the shared `runReplayWorker`
 * — the wrapper owns row lifecycle (`pending → running → completed|failed`)
 * + `session_ended` bookend so this function only describes the WS
 * transport: open a socket, send the manifest, stream per-turn audio,
 * collect frames until `turn.done`.
 */
export async function runRealtimeReplay(opts: RunRealtimeReplayOptions): Promise<void> {
	const factory: WebSocketFactory = opts.webSocketFactory ?? ((url) => new WebSocket(url));
	await runReplayWorker(
		{ store: opts.store, runId: opts.runId, ...(opts.now ? { now: opts.now } : {}) },
		async ({ store, run, now }) => {
			await driveRealtimeReplay({ store, run, audioRoot: opts.audioRoot, factory, now });
		},
	);
}

interface DriveOptions {
	store: Store;
	run: ReplayRunRow;
	audioRoot: string;
	factory: WebSocketFactory;
	now: () => string;
}

async function driveRealtimeReplay(opts: DriveOptions): Promise<void> {
	const { store, run, audioRoot, factory, now } = opts;
	const sourceTurns = listTurnsForSession(store.db, run.sourceSessionId);
	const userIndices = sourceTurns.map((t, i) => (t.role === "user" ? i : -1)).filter((i) => i >= 0);

	const manifest = buildManifest(store, run.sourceSessionId, sourceTurns);

	const session = await openWebhookSession(factory, run.webhookUrl);
	let completed = 0;
	try {
		try {
			session.send({
				type: "session.start",
				protocolVersion: REALTIME_REPLAY_PROTOCOL_VERSION,
				sourceSessionId: run.sourceSessionId,
				targetSessionId: run.targetSessionId,
				turns: manifest,
			});

			if (userIndices.length === 0) {
				session.send({ type: "session.end" });
				updateReplayRunProgress(store.db, run.id, { completed: 0, total: 0 });
				return;
			}

			applyEvent(store, run.targetSessionId, {
				type: "session_started",
				agentId: `replay:${run.sourceSessionId}`,
				startedAt: now(),
			});

			let targetIdx = 0;

			for (const userIdx of userIndices) {
				const userTurn = sourceTurns[userIdx];
				if (userTurn === undefined) continue;

				await streamUserAudio(session, audioRoot, userTurn);

				// Atomic semantics: wait for the agent response BEFORE writing the
				// user row so a half-written turn never leaks into the diff view.
				const collected = await collectAgentTurn(session, userTurn.idx);

				applyEvent(store, run.targetSessionId, {
					type: "turn_completed",
					idx: targetIdx,
					role: "user",
					text: userTurn.text,
					timestamp: now(),
				});

				const agentIdx = targetIdx + 1;
				await writeAgentTurn(store, audioRoot, run.targetSessionId, agentIdx, collected, now);

				targetIdx += 2;
				completed += 1;
				updateReplayRunProgress(store.db, run.id, { completed });
			}

			session.send({ type: "session.end" });
		} catch (err) {
			// `WebhookSession` throws `WebhookClosedEarlyError` with sentinel
			// counters because it doesn't own the drive loop's progress. Re-stamp
			// with the real `(completed, total)` here — the drive loop is the
			// only call site that has them.
			if (err instanceof WebhookClosedEarlyError) {
				const info = session.closeInfo();
				throw new WebhookClosedEarlyError(
					completed,
					userIndices.length,
					info?.code ?? err.code,
					info?.reason ?? err.reason,
				);
			}
			throw err;
		}
	} finally {
		session.close();
	}
}

function buildManifest(
	store: Store,
	sourceSessionId: string,
	sourceTurns: TurnRow[],
): TurnManifestEntry[] {
	// One query for all tool calls in the source, grouped by turnId, to avoid
	// N+1 lookups while building the manifest.
	const callsByTurnId = groupToolCallsByTurnId(listToolCallsForSession(store.db, sourceSessionId));
	return sourceTurns.map((t) => ({
		turnIdx: t.idx,
		role: t.role,
		text: t.text,
		audioContentType: t.audioPath !== null ? contentTypeFromAudioPath(t.audioPath) : null,
		recordedToolResults:
			t.role === "agent"
				? toRecordedToolResults(sourceSessionId, t, callsByTurnId.get(t.id) ?? [])
				: [],
	}));
}

function contentTypeFromAudioPath(path: string): AudioContentType {
	const ext = extname(path).slice(1);
	const ct = EXTENSION_TO_CONTENT_TYPE[ext];
	if (ct === undefined) {
		// Audio writer guarantees a known extension; an unknown one is data
		// corruption from a hand-edit.
		throw new UnknownAudioExtensionError(ext, path);
	}
	return ct;
}

function toRecordedToolResults(
	sourceSessionId: string,
	agentTurn: TurnRow,
	calls: ToolCallRow[],
): RecordedToolResult[] {
	return calls.map((tc) => ({
		name: tc.name,
		args: parseToolJson(sourceSessionId, agentTurn.id, "args", tc.argsJson),
		result:
			tc.resultJson === null
				? null
				: parseToolJson(sourceSessionId, agentTurn.id, "result", tc.resultJson),
	}));
}

/** `error` frames are intercepted by the WS message handler and rethrown
 *  through the iterator as `WebhookReportedError`; they never appear as a
 *  yielded frame, so the iterator's element type narrows them out. The
 *  consumer's `match` then needs only the four real protocol frames. */
type DeliverableFrame = Exclude<ServerFrame, { type: "error" }>;

interface WebhookSession {
	send(frame: ClientFrame): void;
	close(): void;
	/** Async iterator over server frames. Returns when the WS closes cleanly;
	 *  throws the typed reason (`WebhookReportedError`,
	 *  `WebhookInvalidFrameError`, `WebhookMalformedFrameError`) when an error
	 *  frame or malformed input arrived. The consumer constructs
	 *  `WebhookClosedEarlyError` itself when the iterator returns before its
	 *  expected terminal frame — only the consumer knows what "early" means. */
	frames(): AsyncIterableIterator<DeliverableFrame>;
	/** Latched close info, queryable so the drive loop can construct
	 *  `WebhookClosedEarlyError` with the right turns-completed counter. */
	closeInfo(): { code: number; reason: string } | null;
}

async function openWebhookSession(
	factory: WebSocketFactory,
	webhookUrl: string,
): Promise<WebhookSession> {
	let ws: WebSocket;
	try {
		ws = factory(webhookUrl);
	} catch (cause) {
		throw new WebhookConnectError(webhookUrl, errorMessage(cause), { cause });
	}

	const queue: DeliverableFrame[] = [];
	let closedAt: { code: number; reason: string } | null = null;
	let firstError: unknown = null;
	let pendingWake: (() => void) | null = null;
	const wake = (): void => {
		if (pendingWake !== null) {
			const resume = pendingWake;
			pendingWake = null;
			resume();
		}
	};

	ws.addEventListener("message", (event) => {
		const text = typeof event.data === "string" ? event.data : null;
		if (text === null) {
			if (firstError === null) firstError = new WebhookMalformedFrameError();
			wake();
			return;
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch (cause) {
			if (firstError === null) firstError = new WebhookMalformedFrameError({ cause });
			wake();
			return;
		}
		const parsed = v.safeParse(ServerFrameSchema, json);
		if (!parsed.success) {
			if (firstError === null) firstError = new WebhookInvalidFrameError(parsed.issues);
			wake();
			return;
		}
		if (parsed.output.type === "error") {
			if (firstError === null) {
				firstError = new WebhookReportedError(parsed.output.code, parsed.output.message);
			}
			wake();
			return;
		}
		queue.push(parsed.output);
		wake();
	});

	ws.addEventListener("close", (event) => {
		closedAt = { code: event.code, reason: event.reason };
		wake();
	});

	ws.addEventListener("error", () => {
		// "error" without "close" doesn't happen on Bun's WebSocket — the close
		// event fires immediately after with code 1006. Hold for that event.
	});

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener(
			"close",
			(event) => {
				if (ws.readyState !== WebSocket.OPEN) {
					reject(
						new WebhookConnectError(
							webhookUrl,
							`closed before open (code=${event.code}, reason=${event.reason || "(none)"})`,
						),
					);
				}
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				if (ws.readyState !== WebSocket.OPEN) {
					reject(new WebhookConnectError(webhookUrl, "connection error"));
				}
			},
			{ once: true },
		);
	});

	async function* iter(): AsyncIterableIterator<DeliverableFrame> {
		for (;;) {
			if (firstError !== null) throw firstError;
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (closedAt !== null) return;
			await new Promise<void>((resolve) => {
				pendingWake = resolve;
			});
		}
	}

	return {
		send(frame: ClientFrame): void {
			// Guard readyState: if the webhook closed between two engine sends,
			// `ws.send` would throw a low-quality DOMException. Prefer any
			// already-latched error frame (`firstError`) so a webhook that
			// emits a typed `error` then immediately closes surfaces as
			// `WebhookReportedError`, not as the generic close-early.
			if (ws.readyState !== WebSocket.OPEN) {
				if (firstError !== null) throw firstError;
				const info = closedAt;
				throw new WebhookClosedEarlyError(
					0,
					0,
					info?.code ?? 1006,
					info?.reason ?? "send on closed socket",
				);
			}
			ws.send(JSON.stringify(frame));
		},
		close(): void {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				ws.close(1000, "session complete");
			}
		},
		frames: iter,
		closeInfo: () => closedAt,
	};
}

interface CollectedAgentTurn {
	audioBytes: Uint8Array;
	audioContentType: AudioContentType | null;
	transcript: string;
	responseLatencyMs?: number;
	interrupted?: boolean;
	toolCalls: Array<{
		idx: number;
		name: string;
		args: unknown;
		result: unknown;
		latencyMs: number | null;
	}>;
}

/**
 * Stream one source user turn's recorded audio into the session: zero or more
 * `user_audio.append` frames (chunked to MAX_REALTIME_AUDIO_CHUNK_BYTES) plus
 * a final `user_audio.commit`. A turn with no audio sends just the commit.
 */
async function streamUserAudio(
	session: WebhookSession,
	audioRoot: string,
	userTurn: TurnRow,
): Promise<void> {
	if (userTurn.audioPath !== null) {
		const fullPath = join(audioRoot, userTurn.audioPath);
		const bytes = await readFile(fullPath);
		// Chunk in raw-byte terms. Base64 expansion (4/3) happens per chunk.
		for (let offset = 0; offset < bytes.length; offset += MAX_REALTIME_AUDIO_CHUNK_BYTES) {
			const slice = bytes.subarray(offset, offset + MAX_REALTIME_AUDIO_CHUNK_BYTES);
			session.send({
				type: "user_audio.append",
				turnIdx: userTurn.idx,
				audioBase64: Buffer.from(slice).toString("base64"),
			});
		}
	}
	session.send({ type: "user_audio.commit", turnIdx: userTurn.idx });
}

/**
 * Pull server frames until a `turn.done` for `expectedTurnIdx` arrives.
 * Mid-turn audio chunks with diverging contentType throw. Per-turn audio
 * bytes are capped at `MAX_REALTIME_AGENT_AUDIO_BYTES_PER_TURN` and
 * `tool_called` count at `MAX_REALTIME_TOOL_CALLS_PER_TURN` so a webhook
 * that streams forever can't OOM the engine or fill the audio volume.
 * `agent_transcript.delta` text is intentionally NOT accumulated — the
 * `turn.done.transcript` field is authoritative; deltas are a progress-UI
 * signal that we forward but don't persist.
 *
 * Throws `WebhookClosedEarlyError` with sentinel (0,0) counters when the
 * frame iterator returns without yielding a `turn.done` — the drive loop
 * catches and re-stamps with real (completed, total) counters.
 */
async function collectAgentTurn(
	session: WebhookSession,
	expectedTurnIdx: number,
): Promise<CollectedAgentTurn> {
	const collected: CollectedAgentTurn = {
		audioBytes: new Uint8Array(0),
		audioContentType: null,
		transcript: "",
		toolCalls: [],
	};
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	for await (const frame of session.frames()) {
		if (frame.turnIdx !== expectedTurnIdx) {
			throw new UnknownTurnIdxError(frame.turnIdx);
		}
		const done = match(frame)
			.with({ type: "agent_audio.delta" }, (f) => {
				if (collected.audioContentType === null) {
					collected.audioContentType = f.contentType;
				} else if (collected.audioContentType !== f.contentType) {
					throw new ContentTypeChangedMidTurnError(
						expectedTurnIdx,
						collected.audioContentType,
						f.contentType,
					);
				}
				const decoded = Buffer.from(f.audioBase64, "base64");
				if (totalBytes + decoded.byteLength > MAX_REALTIME_AGENT_AUDIO_BYTES_PER_TURN) {
					throw new AgentTurnTooLargeError(
						expectedTurnIdx,
						totalBytes + decoded.byteLength,
						MAX_REALTIME_AGENT_AUDIO_BYTES_PER_TURN,
					);
				}
				chunks.push(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength));
				totalBytes += decoded.byteLength;
				return false;
			})
			.with({ type: "agent_transcript.delta" }, () => false)
			.with({ type: "tool_called" }, (f) => {
				if (collected.toolCalls.length >= MAX_REALTIME_TOOL_CALLS_PER_TURN) {
					throw new TooManyToolCallsError(expectedTurnIdx, MAX_REALTIME_TOOL_CALLS_PER_TURN);
				}
				collected.toolCalls.push({
					idx: f.idx,
					name: f.name,
					args: f.args,
					result: f.result ?? null,
					latencyMs: f.latencyMs ?? null,
				});
				return false;
			})
			.with({ type: "turn.done" }, (f) => {
				collected.transcript = f.transcript;
				if (f.responseLatencyMs !== undefined) collected.responseLatencyMs = f.responseLatencyMs;
				if (f.interrupted !== undefined) collected.interrupted = f.interrupted;
				return true;
			})
			.exhaustive();
		if (done) {
			if (chunks.length > 0) {
				const merged = new Uint8Array(totalBytes);
				let offset = 0;
				for (const c of chunks) {
					merged.set(c, offset);
					offset += c.byteLength;
				}
				collected.audioBytes = merged;
			}
			return collected;
		}
	}

	// Iterator exhausted without `turn.done` — webhook closed mid-turn.
	const info = session.closeInfo();
	throw new WebhookClosedEarlyError(0, 0, info?.code ?? 1006, info?.reason ?? "closed mid-turn");
}

async function writeAgentTurn(
	store: Store,
	audioRoot: string,
	targetSessionId: string,
	agentIdx: number,
	collected: CollectedAgentTurn,
	now: () => string,
): Promise<void> {
	// Atomicity: a partially-written agent turn (text row exists but audio
	// upload failed) used to leave the diff view rendering text without
	// playback AND the run "stuck" because the progress counter wouldn't
	// advance. Insert text + tool calls first, then upload audio; if the
	// upload throws, delete the row (FK CASCADE removes the tool_calls)
	// so the caller's failure surfaces as "no agent turn N" instead of
	// "agent turn N is text-only despite the webhook sending bytes."
	applyEvent(store, targetSessionId, {
		type: "turn_completed",
		idx: agentIdx,
		role: "agent",
		text: collected.transcript,
		timestamp: now(),
		...(collected.responseLatencyMs !== undefined
			? { responseLatencyMs: collected.responseLatencyMs }
			: {}),
		...(collected.interrupted !== undefined ? { interrupted: collected.interrupted } : {}),
	});

	for (const tc of collected.toolCalls) {
		applyEvent(store, targetSessionId, {
			type: "tool_called",
			turnIdx: agentIdx,
			idx: tc.idx,
			name: tc.name,
			args: tc.args,
			...(tc.result !== null && tc.result !== undefined ? { result: tc.result } : {}),
			...(tc.latencyMs !== null ? { latencyMs: tc.latencyMs } : {}),
		});
	}

	if (collected.audioBytes.byteLength > 0 && collected.audioContentType !== null) {
		try {
			// Reuse the audio service's writer so file naming + audio_path stamping
			// stays in one place per single-image-distribution.md.
			await uploadTurnAudio(store, audioRoot, {
				sessionId: targetSessionId,
				turnIdx: agentIdx,
				contentType: collected.audioContentType,
				bytes: ensureArrayBufferBacked(collected.audioBytes),
			});
		} catch (err) {
			deleteTurnByIdx(store.db, targetSessionId, agentIdx);
			throw err;
		}
	}
}

function ensureArrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	// Always copy into a fresh ArrayBuffer-backed view. Avoids an `as` cast on
	// the lib.dom Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer> shape;
	// per-turn megabytes make the extra copy negligible.
	const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	copy.set(bytes);
	return copy;
}
