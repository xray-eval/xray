import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { and, count, eq } from "drizzle-orm";
import { match } from "ts-pattern";
import type { BaseIssue } from "valibot";
import * as v from "valibot";

import { uploadTurnAudio } from "@/server/audio/audio.service.ts";
import type { AudioContentType } from "@/server/audio/audio.types.ts";
import { applyEvent } from "@/server/ingest/ingest.service.ts";
import {
	CorruptToolCallJsonError,
	ReplayRunNotFoundError,
	SourceSessionNotFoundError,
} from "@/server/replays/replays.errors.ts";
import {
	createReplayRun,
	finishReplayRun,
	getReplayRun,
	markReplayRunRunning,
	updateReplayRunProgress,
} from "@/server/store/replay-runs-repo.ts";
import { turns } from "@/server/store/schema.ts";
import { getSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { listToolCallsForTurn } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";
import type { ReplayRunRow, TurnRow } from "@/server/store/types.ts";

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
} from "./realtime-replay.errors.ts";
import type {
	ClientFrame,
	CreateRealtimeReplayRequest,
	RecordedToolResult,
	ServerFrame,
	TurnManifestEntry,
} from "./realtime-replay.types.ts";
import {
	MAX_REALTIME_AGENT_AUDIO_BYTES_PER_TURN,
	MAX_REALTIME_AUDIO_CHUNK_BYTES,
	MAX_REALTIME_TOOL_CALLS_PER_TURN,
	REALTIME_REPLAY_PROTOCOL_VERSION,
	ServerFrameSchema,
} from "./realtime-replay.types.ts";

const EXTENSION_TO_CONTENT_TYPE: Record<string, AudioContentType> = {
	opus: "audio/opus",
	ogg: "audio/ogg",
	webm: "audio/webm",
	mp3: "audio/mp3",
	wav: "audio/wav",
};

/**
 * Insert a `replay_runs` row with `mode='realtime'` and return it. Mirrors
 * `createReplay` from the text-replay slice but writes the realtime mode
 * marker. The WS worker that actually drives the run is kicked off
 * separately by the router (fire-and-forget).
 *
 * Throws `SourceSessionNotFoundError` if `req.sourceSessionId` doesn't exist.
 */
export function createRealtimeReplay(store: Store, req: CreateRealtimeReplayRequest): ReplayRunRow {
	if (getSession(store.db, req.sourceSessionId) === undefined) {
		throw new SourceSessionNotFoundError(req.sourceSessionId);
	}
	const id = crypto.randomUUID();
	const targetSessionId = `replay-${crypto.randomUUID()}`;
	const userTurnCount = countUserTurns(store, req.sourceSessionId);
	const row: ReplayRunRow = {
		id,
		sourceSessionId: req.sourceSessionId,
		targetSessionId,
		status: "pending",
		mode: "realtime",
		webhookUrl: req.webhookUrl,
		progressCompleted: 0,
		progressTotal: userTurnCount,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		error: null,
	};
	createReplayRun(store.db, row);
	return row;
}

function countUserTurns(store: Store, sessionId: string): number {
	const row = store.db
		.select({ n: count() })
		.from(turns)
		.where(and(eq(turns.sessionId, sessionId), eq(turns.role, "user")))
		.get();
	return row?.n ?? 0;
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
 * Drive one realtime replay run end-to-end.
 *
 * 1. Open a WebSocket to the run's `webhookUrl`.
 * 2. Send `session.start` with the per-turn manifest (text + audio content-type
 *    + recorded tool results).
 * 3. For each source user turn, stream `user_audio.append` chunks + a
 *    `user_audio.commit`, then drain server frames until `turn.done` —
 *    writing tool_called and the agent turn + audio file along the way.
 * 4. Send `session.end`, then a clean `session_ended` to the target.
 *
 * On any failure the run is marked `failed` with the error message and the
 * throw propagates so the caller can log it. The accumulated turns in the
 * target session are NOT rolled back — they're the surviving evidence the
 * UI can show ("got 3 of 5 turns before the webhook crashed").
 */
export async function runRealtimeReplay(opts: RunRealtimeReplayOptions): Promise<void> {
	const { store, audioRoot, runId } = opts;
	const factory: WebSocketFactory = opts.webSocketFactory ?? ((url) => new WebSocket(url));
	const now = opts.now ?? (() => new Date().toISOString());

	const run = getReplayRun(store.db, runId);
	if (run === undefined) {
		throw new ReplayRunNotFoundError(runId);
	}

	markReplayRunRunning(store.db, runId);

	const startedAtMs = Date.now();
	try {
		await driveRealtimeReplay({ store, run, audioRoot, factory, now });
		const finishedAt = now();
		applyEvent(store, run.targetSessionId, {
			type: "session_ended",
			endedAt: finishedAt,
			durationMs: Date.now() - startedAtMs,
		});
		finishReplayRun(store.db, runId, "completed", { finishedAt });
	} catch (err) {
		const finishedAt = now();
		finishReplayRun(store.db, runId, "failed", {
			finishedAt,
			error: errorMessage(err),
		});
		throw err;
	}
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

		let completed = 0;
		let targetIdx = 0;

		for (const userIdx of userIndices) {
			const userTurn = sourceTurns[userIdx];
			if (userTurn === undefined) continue;

			await streamUserAudio(session, audioRoot, userTurn);

			// Atomic semantics: wait for the agent response BEFORE writing the
			// user row so a half-written turn never leaks into the diff view.
			session.setProgress(completed, userIndices.length);
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
	} finally {
		session.close();
	}
}

function buildManifest(
	store: Store,
	sourceSessionId: string,
	sourceTurns: TurnRow[],
): TurnManifestEntry[] {
	return sourceTurns.map((t) => ({
		turnIdx: t.idx,
		role: t.role,
		text: t.text,
		audioContentType: t.audioPath !== null ? contentTypeFromAudioPath(t.audioPath) : null,
		recordedToolResults:
			t.role === "agent" ? readRecordedToolResults(store, sourceSessionId, t) : [],
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

function readRecordedToolResults(
	store: Store,
	sourceSessionId: string,
	agentTurn: TurnRow,
): RecordedToolResult[] {
	return listToolCallsForTurn(store.db, agentTurn.id).map((tc) => ({
		name: tc.name,
		args: parseToolJson(sourceSessionId, agentTurn.id, "args", tc.argsJson),
		result:
			tc.resultJson === null
				? null
				: parseToolJson(sourceSessionId, agentTurn.id, "result", tc.resultJson),
	}));
}

function parseToolJson(
	sessionId: string,
	turnId: string,
	field: "args" | "result",
	raw: string,
): unknown {
	try {
		return JSON.parse(raw);
	} catch (cause) {
		throw new CorruptToolCallJsonError(sessionId, turnId, field, cause);
	}
}

interface WebhookSession {
	send(frame: ClientFrame): void;
	close(): void;
	/** Updates the progress numbers used to annotate a `WebhookClosedEarlyError`. */
	setProgress(completed: number, total: number): void;
	nextFrame<K extends ServerFrame["type"]>(
		types: readonly K[],
	): Promise<Extract<ServerFrame, { type: K }>>;
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

	interface Pending {
		readonly types: ReadonlySet<ServerFrame["type"]>;
		readonly resolve: (frame: ServerFrame) => void;
		readonly reject: (err: unknown) => void;
	}

	const queue: ServerFrame[] = [];
	const waiters: Pending[] = [];
	let closeInfo: { code: number; reason: string } | null = null;
	let firstError: unknown = null;
	const progress = { completed: 0, total: 1 };

	const drainWaiterUsingClose = (w: Pending): void => {
		const info = closeInfo;
		const cause =
			firstError ??
			new WebhookClosedEarlyError(
				progress.completed,
				progress.total,
				info?.code ?? 1006,
				info?.reason ?? "closed early",
			);
		w.reject(cause);
	};

	const tryDeliver = (): void => {
		while (waiters.length > 0 && queue.length > 0) {
			const w = waiters[0];
			const frame = queue[0];
			if (w === undefined || frame === undefined) return;
			if (w.types.has(frame.type)) {
				queue.shift();
				waiters.shift();
				w.resolve(frame);
			} else {
				// Out-of-order frame for this waiter — surface as an error rather
				// than silently drop. The protocol orders strictly.
				queue.shift();
				waiters.shift();
				w.reject(
					new WebhookInvalidFrameError([
						{
							kind: "schema",
							type: "frame_order",
							input: frame,
							expected: [...w.types].join("|"),
							received: frame.type,
							message: `expected one of [${[...w.types].join(", ")}], got ${frame.type}`,
						} satisfies BaseIssue<unknown>,
					]),
				);
			}
		}
		if (closeInfo !== null) {
			while (waiters.length > 0) {
				const w = waiters.shift();
				if (w === undefined) break;
				drainWaiterUsingClose(w);
			}
		}
	};

	const enqueueError = (err: unknown): void => {
		if (firstError === null) firstError = err;
		while (waiters.length > 0) {
			const w = waiters.shift();
			if (w === undefined) break;
			w.reject(err);
		}
	};

	ws.addEventListener("message", (event) => {
		const text = typeof event.data === "string" ? event.data : null;
		if (text === null) {
			enqueueError(new WebhookMalformedFrameError());
			return;
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch (cause) {
			enqueueError(new WebhookMalformedFrameError({ cause }));
			return;
		}
		const parsed = v.safeParse(ServerFrameSchema, json);
		if (!parsed.success) {
			enqueueError(new WebhookInvalidFrameError(parsed.issues));
			return;
		}
		if (parsed.output.type === "error") {
			enqueueError(new WebhookReportedError(parsed.output.code, parsed.output.message));
			return;
		}
		queue.push(parsed.output);
		tryDeliver();
	});

	ws.addEventListener("close", (event) => {
		closeInfo = { code: event.code, reason: event.reason };
		tryDeliver();
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

	return {
		send(frame: ClientFrame): void {
			// Guard readyState: if the webhook closed between two engine sends,
			// `ws.send` would throw a low-quality DOMException. Prefer any
			// already-latched error frame (`firstError`) so a webhook that
			// emits a typed `error` then immediately closes surfaces as
			// `WebhookReportedError`, not as the generic close-early.
			if (ws.readyState !== WebSocket.OPEN) {
				if (firstError !== null) throw firstError;
				const info = closeInfo;
				throw new WebhookClosedEarlyError(
					progress.completed,
					progress.total,
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
		setProgress(completed, total) {
			progress.completed = completed;
			progress.total = total;
		},
		nextFrame<K extends ServerFrame["type"]>(
			types: readonly K[],
		): Promise<Extract<ServerFrame, { type: K }>> {
			return new Promise<Extract<ServerFrame, { type: K }>>((resolve, reject) => {
				const allowed: ReadonlySet<ServerFrame["type"]> = new Set<ServerFrame["type"]>(types);
				waiters.push({
					types: allowed,
					// `tryDeliver` only forwards frames whose `type` is in `allowed`,
					// so the inner `match` is exhaustive at runtime and the throw
					// path is unreachable. The throw stays to satisfy the no-`as`
					// rule (per .claude/rules/no-lint-suppressions.md).
					resolve: (frame) =>
						resolve(
							match(frame)
								.when(
									(f): f is Extract<ServerFrame, { type: K }> => allowed.has(f.type),
									(f) => f,
								)
								.otherwise(() => {
									throw new WebhookInvalidFrameError([]);
								}),
						),
					reject,
				});
				tryDeliver();
			});
		},
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

	for (;;) {
		const frame = await session.nextFrame([
			"agent_audio.delta",
			"agent_transcript.delta",
			"tool_called",
			"turn.done",
		] as const);
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

		if (done) break;
	}

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

async function writeAgentTurn(
	store: Store,
	audioRoot: string,
	targetSessionId: string,
	agentIdx: number,
	collected: CollectedAgentTurn,
	now: () => string,
): Promise<void> {
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
		// Reuse the audio service's writer so file naming + audio_path stamping
		// stays in one place per single-image-distribution.md.
		await uploadTurnAudio(store, audioRoot, {
			sessionId: targetSessionId,
			turnIdx: agentIdx,
			contentType: collected.audioContentType,
			bytes: ensureArrayBufferBacked(collected.audioBytes),
		});
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

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
