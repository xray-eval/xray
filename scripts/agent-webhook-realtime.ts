// FOR XRAY CONTRIBUTORS ONLY — not a feature of xray itself.
//
// Sibling of `scripts/agent-webhook.ts` for the V2V (realtime) replay path.
// Where `agent-webhook.ts` accepts an HTTP POST per turn, this script accepts
// a WebSocket connection per replay run and bridges it to OpenAI Realtime so
// `runRealtimeReplay` can stream recorded user audio and capture the agent's
// audio + transcript per turn.
//
// What it does:
//   1. Listens on :4001 (overridable via --port / REALTIME_PORT).
//   2. Accepts ONE WebSocket per run at any path.
//   3. Reads the `session.start` frame, opens a downstream WS to
//      `wss://api.openai.com/v1/realtime?model=$REALTIME_MODEL`.
//   4. Sends `session.update` to OpenAI with our system prompt, PCM16/24k
//      input+output, server VAD turn detection, plus the source's recorded
//      tools as function definitions (so the model can attempt calls).
//   5. For each `user_audio.append` from xray, appends to OpenAI's
//      `input_audio_buffer.append`. On `user_audio.commit`, commits the
//      buffer and triggers `response.create`.
//   6. As OpenAI streams `response.audio.delta` /
//      `response.audio_transcript.delta` back, relays them to xray as
//      `agent_audio.delta` / `agent_transcript.delta`. On `response.done`,
//      sends `turn.done`.
//   7. When OpenAI emits `response.function_call_arguments.done`, looks up
//      the recorded result by tool name and `conversation.item.create`s a
//      `function_call_output` back to OpenAI, then re-triggers
//      `response.create`. Also forwards the call to xray as a `tool_called`
//      frame for the target session's record.
//
// Audio format constraint:
//   OpenAI Realtime accepts `pcm16`, `g711_ulaw`, `g711_alaw`. Source audio
//   in opus/webm/mp3 is NOT decoded by this script (decode would need an
//   ffmpeg subprocess; out of scope for a contributor demo). When the source
//   manifest's `audioContentType` is not directly supported, the script
//   emits an `error` frame and closes — the contributor sees a clear
//   message in xray's run row.
//
// Usage (sibling compose service — intended path):
//   pnpm dev:webhook                                  # already brings up
//                                                     # both webhooks together
//   # In the UI: realtime replay URL `ws://agent-webhook-realtime:4001/`
//
// Usage (bare on host):
//   OPENAI_API_KEY=sk-... bun scripts/agent-webhook-realtime.ts
//
// Configuration (env vars):
//   OPENAI_API_KEY        required
//   REALTIME_MODEL        default "gpt-realtime"
//   REALTIME_VOICE        default "alloy"
//   AGENT_SYSTEM_PROMPT   default neutral baseline
//   REALTIME_PORT         default 4001
//
// CLI flags (--port, --model, --voice, --system) override env vars.
//
// Why no openai SDK: same reason as agent-webhook.ts — keeps the
// contributor-only script out of package.json + the 7-day cooldown.

import type { ServerWebSocket } from "bun";
import { match } from "ts-pattern";
import * as v from "valibot";

import type {
	ClientFrame,
	ServerFrame,
	TurnManifestEntry,
} from "@/server/realtime-replay/realtime-replay.types.ts";
import {
	ClientFrameSchema,
	REALTIME_REPLAY_PROTOCOL_VERSION,
} from "@/server/realtime-replay/realtime-replay.types.ts";

// Per boundary-validation.md: env parsed once at startup.
const EnvSchema = v.object({
	OPENAI_API_KEY: v.pipe(v.string(), v.minLength(1, "OPENAI_API_KEY is required")),
	REALTIME_MODEL: v.optional(v.string()),
	REALTIME_VOICE: v.optional(v.string()),
	AGENT_SYSTEM_PROMPT: v.optional(v.string()),
	REALTIME_PORT: v.optional(v.string()),
});

const envResult = v.safeParse(EnvSchema, process.env);
if (!envResult.success) {
	console.error("Environment validation failed:");
	for (const issue of envResult.issues) {
		const path = issue.path?.map((p) => String(p.key)).join(".") ?? "(root)";
		console.error(`  ${path}: ${issue.message}`);
	}
	process.exit(1);
}
const ENV = envResult.output;

interface ScriptArgs {
	port?: string;
	model?: string;
	voice?: string;
	system?: string;
}
const ARGS: ScriptArgs = parseArgs(process.argv.slice(2));

const PORT = Number(ARGS.port ?? ENV.REALTIME_PORT ?? "4001");
const MODEL = ARGS.model ?? ENV.REALTIME_MODEL ?? "gpt-realtime";
const VOICE = ARGS.voice ?? ENV.REALTIME_VOICE ?? "alloy";
const SYSTEM_PROMPT =
	ARGS.system ??
	ENV.AGENT_SYSTEM_PROMPT ??
	"You are a helpful voice assistant. Keep replies concise and conversational.";

/** OpenAI Realtime only consumes raw PCM16/24k or G.711 — opus/webm/mp3
 *  need a decoder, which this contributor script deliberately doesn't ship. */
const REALTIME_SUPPORTED_INPUT_CONTENT_TYPES: ReadonlySet<string> = new Set(["audio/wav"]);

interface PerSocketState {
	upstream: WebSocket | null;
	/** Resolves once OpenAI's `session.updated` fires — `handleUserAudio*`
	 *  awaits this so audio frames that arrive before the upstream is
	 *  configured aren't silently dropped (the bug that surfaced as
	 *  "replay hangs forever and OpenAI shows zero token usage"). */
	upstreamReady: Promise<void> | null;
	manifestByIdx: Map<number, TurnManifestEntry>;
	awaitingTurnIdx: number | null;
	transcriptAccumulator: string;
	lastTurnStartedAtMs: number | null;
	/** Per-turn PCM16 chunks from OpenAI Realtime, flushed once at turn.done.
	 *  Wrapping each chunk in its own WAV header makes the merged file
	 *  unplayable — most decoders honor the first chunk's `data` length and
	 *  stop there. One header + concatenated PCM is the only correct shape. */
	pcmChunks: Uint8Array[];
}

function freshState(): PerSocketState {
	return {
		upstream: null,
		upstreamReady: null,
		manifestByIdx: new Map(),
		awaitingTurnIdx: null,
		transcriptAccumulator: "",
		lastTurnStartedAtMs: null,
		pcmChunks: [],
	};
}

const server = Bun.serve<PerSocketState, never>({
	port: PORT,
	hostname: "0.0.0.0",
	fetch(req, srv) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/healthz") {
			return new Response("ok\n");
		}
		const upgraded = srv.upgrade(req, { data: freshState() });
		if (upgraded) return undefined;
		return new Response("not a websocket\n", { status: 400 });
	},
	websocket: {
		open() {
			console.info(`[ws] xray connected`);
		},
		async message(ws, raw) {
			const text = typeof raw === "string" ? raw : raw.toString("utf8");
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				sendError(ws, "invalid_json", "frame was not valid JSON");
				ws.close(1003, "invalid_json");
				return;
			}
			const parsed = v.safeParse(ClientFrameSchema, json);
			if (!parsed.success) {
				sendError(ws, "invalid_frame", "frame did not match ClientFrameSchema");
				ws.close(1003, "invalid_frame");
				return;
			}
			await handleClientFrame(ws, parsed.output);
		},
		close(ws, code, reason) {
			ws.data.upstream?.close(1000, "xray disconnected");
			console.info(`[ws] xray disconnected code=${code} reason=${reason || "(none)"}`);
		},
	},
});

console.info(`agent-webhook-realtime listening on ws://0.0.0.0:${server.port}/`);
console.info(`  model: ${MODEL}  voice: ${VOICE}`);

async function handleClientFrame(
	ws: ServerWebSocket<PerSocketState>,
	frame: ClientFrame,
): Promise<void> {
	await match(frame)
		.with({ type: "session.start" }, (f) => handleSessionStart(ws, f))
		.with({ type: "user_audio.append" }, (f) => handleUserAudioAppend(ws, f))
		.with({ type: "user_audio.commit" }, (f) => handleUserAudioCommit(ws, f))
		.with({ type: "session.end" }, () => {
			ws.data.upstream?.close(1000, "session.end");
			ws.close(1000, "session.end");
			return Promise.resolve();
		})
		.exhaustive();
}

async function handleSessionStart(
	ws: ServerWebSocket<PerSocketState>,
	frame: Extract<ClientFrame, { type: "session.start" }>,
): Promise<void> {
	if (frame.protocolVersion !== REALTIME_REPLAY_PROTOCOL_VERSION) {
		sendError(
			ws,
			"protocol_version_mismatch",
			`expected ${REALTIME_REPLAY_PROTOCOL_VERSION}, got ${frame.protocolVersion}`,
		);
		ws.close(1003, "protocol_version_mismatch");
		return;
	}

	for (const turn of frame.turns) {
		ws.data.manifestByIdx.set(turn.turnIdx, turn);
		if (
			turn.role === "user" &&
			turn.audioContentType !== null &&
			!REALTIME_SUPPORTED_INPUT_CONTENT_TYPES.has(turn.audioContentType)
		) {
			sendError(
				ws,
				"unsupported_audio_format",
				`turn ${turn.turnIdx}: OpenAI Realtime needs PCM16/24k mono WAV; got ${turn.audioContentType}. Re-record source audio as WAV or extend this webhook with an ffmpeg decoder.`,
			);
			ws.close(1003, "unsupported_audio_format");
			return;
		}
	}

	const tools = collectTools(frame.turns);
	const { upstream, ready } = openUpstream(ws, tools);
	ws.data.upstream = upstream;
	ws.data.upstreamReady = ready;
}

async function handleUserAudioAppend(
	ws: ServerWebSocket<PerSocketState>,
	frame: Extract<ClientFrame, { type: "user_audio.append" }>,
): Promise<void> {
	const up = await waitForUpstream(ws);
	if (up === null) return;
	up.send(
		JSON.stringify({
			type: "input_audio_buffer.append",
			audio: pcm16WavToBase64Pcm(frame.audioBase64),
		}),
	);
}

async function handleUserAudioCommit(
	ws: ServerWebSocket<PerSocketState>,
	frame: Extract<ClientFrame, { type: "user_audio.commit" }>,
): Promise<void> {
	const up = await waitForUpstream(ws);
	if (up === null) return;
	ws.data.awaitingTurnIdx = frame.turnIdx;
	ws.data.transcriptAccumulator = "";
	ws.data.lastTurnStartedAtMs = Date.now();
	up.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
	up.send(
		JSON.stringify({
			type: "response.create",
			response: { modalities: ["audio", "text"] },
		}),
	);
}

/**
 * Resolves with the upstream WebSocket once OpenAI's `session.updated` has
 * fired — guarantees `input_audio_buffer.append` calls land on a configured
 * upstream. Returns null if the upstream is gone (closed before we could use
 * it); the caller then no-ops.
 */
async function waitForUpstream(ws: ServerWebSocket<PerSocketState>): Promise<WebSocket | null> {
	const ready = ws.data.upstreamReady;
	if (ready !== null) {
		try {
			await ready;
		} catch {
			return null;
		}
	}
	const up = ws.data.upstream;
	if (up === null || up.readyState !== WebSocket.OPEN) return null;
	return up;
}

interface UpstreamTool {
	type: "function";
	name: string;
	description: string;
	parameters: { type: "object"; properties: Record<string, never> };
}

function collectTools(turns: readonly TurnManifestEntry[]): UpstreamTool[] {
	const byName = new Map<string, UpstreamTool>();
	for (const t of turns) {
		for (const r of t.recordedToolResults) {
			if (byName.has(r.name)) continue;
			byName.set(r.name, {
				type: "function",
				name: r.name,
				description: `Tool the original agent had access to. Example call: ${r.name}(${JSON.stringify(r.args)})`,
				parameters: { type: "object", properties: {} },
			});
		}
	}
	return [...byName.values()];
}

interface OpenedUpstream {
	readonly upstream: WebSocket;
	/** Resolves once OpenAI's `session.updated` event fires. Rejects on
	 *  early-close / error so awaiters fall through cleanly. */
	readonly ready: Promise<void>;
}

function openUpstream(
	ws: ServerWebSocket<PerSocketState>,
	tools: readonly UpstreamTool[],
): OpenedUpstream {
	const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
	// Bun's WebSocket constructor accepts a `{ headers }` options object that
	// lib.dom's WebSocket does not. `Reflect.construct` forwards extra args
	// without going through the narrow lib.dom signature — no `as` cast, no
	// `@ts-expect-error`, no lib reshape. The runtime is Bun's WebSocket.
	const upstream: WebSocket = Reflect.construct(WebSocket, [
		url,
		{ headers: { Authorization: `Bearer ${ENV.OPENAI_API_KEY}` } },
	]);

	let resolveReady: (() => void) | null = null;
	let rejectReady: ((err: unknown) => void) | null = null;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	upstream.addEventListener("open", () => {
		console.info(`[upstream] connected to OpenAI Realtime (model=${MODEL})`);
		// Manual turn detection: we control commit + response.create explicitly.
		// `server_vad` would race against our manual commit for pre-recorded
		// audio and the response would either never fire or fire on the wrong
		// turn boundary.
		upstream.send(
			JSON.stringify({
				type: "session.update",
				session: {
					modalities: ["audio", "text"],
					voice: VOICE,
					input_audio_format: "pcm16",
					output_audio_format: "pcm16",
					instructions: SYSTEM_PROMPT,
					turn_detection: null,
					tools,
					tool_choice: tools.length > 0 ? "auto" : "none",
				},
			}),
		);
	});

	upstream.addEventListener("message", (event) => {
		const text = typeof event.data === "string" ? event.data : null;
		if (text === null) return;
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return;
		}
		const evtType =
			json !== null && typeof json === "object" && "type" in json && typeof json.type === "string"
				? json.type
				: null;
		if (evtType === "session.updated" && resolveReady !== null) {
			console.info(`[upstream] session ready`);
			resolveReady();
			resolveReady = null;
			rejectReady = null;
			return;
		}
		if (evtType === "error") {
			console.error(`[upstream] error event:`, json);
		}
		handleUpstreamEvent(ws, upstream, json);
	});

	upstream.addEventListener("close", (event) => {
		const reason = event.reason || "(no reason)";
		console.error(
			`[upstream] closed code=${event.code} reason=${reason} wasClean=${event.wasClean}`,
		);
		if (rejectReady !== null) {
			rejectReady(new Error(`upstream closed before session.updated (${event.code})`));
			resolveReady = null;
			rejectReady = null;
		}
		if (ws.readyState === WebSocket.OPEN) {
			sendError(
				ws,
				"upstream_closed",
				`OpenAI Realtime closed (code=${event.code} reason=${reason}). Common causes: ` +
					`invalid OPENAI_API_KEY, no Realtime access on this org, or model "${MODEL}" not available.`,
			);
			ws.close(1011, "upstream_closed");
		}
	});

	upstream.addEventListener("error", (event) => {
		console.error(`[upstream] error event`, event);
		if (rejectReady !== null) {
			rejectReady(new Error("upstream error before session.updated"));
			resolveReady = null;
			rejectReady = null;
		}
		if (ws.readyState === WebSocket.OPEN) {
			sendError(ws, "upstream_error", "OpenAI Realtime connection error — check OPENAI_API_KEY");
			ws.close(1011, "upstream_error");
		}
	});

	return { upstream, ready };
}

/**
 * Subset of OpenAI Realtime server events this script consumes. Validated
 * with Valibot at the WS boundary per `.claude/rules/boundary-validation.md`
 * so a bad event payload from upstream surfaces as a typed dispatch failure
 * instead of a silent `String(undefined)` later. Unknown events fall through
 * the variant and are ignored.
 */
const UpstreamAudioDelta = v.object({
	type: v.literal("response.audio.delta"),
	delta: v.string(),
});
const UpstreamTranscriptDelta = v.object({
	type: v.literal("response.audio_transcript.delta"),
	delta: v.string(),
});
const UpstreamFunctionCallDone = v.object({
	type: v.literal("response.function_call_arguments.done"),
	name: v.string(),
	arguments: v.string(),
	call_id: v.optional(v.string()),
});
const UpstreamResponseDone = v.object({ type: v.literal("response.done") });
const UpstreamError = v.object({
	type: v.literal("error"),
	message: v.optional(v.string()),
});
const UpstreamEventSchema = v.variant("type", [
	UpstreamAudioDelta,
	UpstreamTranscriptDelta,
	UpstreamFunctionCallDone,
	UpstreamResponseDone,
	UpstreamError,
]);

function handleUpstreamEvent(
	ws: ServerWebSocket<PerSocketState>,
	upstream: WebSocket,
	json: unknown,
): void {
	const parsed = v.safeParse(UpstreamEventSchema, json);
	if (!parsed.success) return; // ignore events we don't model
	const turnIdx = ws.data.awaitingTurnIdx;
	if (turnIdx === null) return;
	const sendFrame = (frame: ServerFrame): void => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	};
	match(parsed.output)
		.with({ type: "response.audio.delta" }, (e) => {
			// Buffer raw PCM only — the WAV header is prepended once at
			// turn.done so the engine writes a single playable file.
			ws.data.pcmChunks.push(new Uint8Array(Buffer.from(e.delta, "base64")));
		})
		.with({ type: "response.audio_transcript.delta" }, (e) => {
			ws.data.transcriptAccumulator += e.delta;
			sendFrame({ type: "agent_transcript.delta", turnIdx, text: e.delta });
		})
		.with({ type: "response.function_call_arguments.done" }, (e) => {
			const recorded = findRecordedToolResult(ws.data.manifestByIdx, e.name);
			if (e.call_id !== undefined && e.call_id !== "") {
				upstream.send(
					JSON.stringify({
						type: "conversation.item.create",
						item: {
							type: "function_call_output",
							call_id: e.call_id,
							output: JSON.stringify(recorded ?? { error: `no recorded result for ${e.name}` }),
						},
					}),
				);
				upstream.send(JSON.stringify({ type: "response.create" }));
			}
			sendFrame({
				type: "tool_called",
				turnIdx,
				idx: 0,
				name: e.name,
				args: safeParseJson(e.arguments),
				...(recorded !== undefined ? { result: recorded } : {}),
			});
		})
		.with({ type: "response.done" }, () => {
			const totalPcm = ws.data.pcmChunks.reduce((n, c) => n + c.byteLength, 0);
			if (totalPcm > 0) {
				const merged = new Uint8Array(totalPcm);
				let offset = 0;
				for (const c of ws.data.pcmChunks) {
					merged.set(c, offset);
					offset += c.byteLength;
				}
				sendFrame({
					type: "agent_audio.delta",
					turnIdx,
					audioBase64: pcmToWavBase64(Buffer.from(merged).toString("base64")),
					contentType: "audio/wav",
				});
			}
			const responseLatencyMs =
				ws.data.lastTurnStartedAtMs !== null ? Date.now() - ws.data.lastTurnStartedAtMs : undefined;
			sendFrame({
				type: "turn.done",
				turnIdx,
				transcript: ws.data.transcriptAccumulator,
				...(responseLatencyMs !== undefined ? { responseLatencyMs } : {}),
			});
			ws.data.awaitingTurnIdx = null;
			ws.data.transcriptAccumulator = "";
			ws.data.lastTurnStartedAtMs = null;
			ws.data.pcmChunks = [];
		})
		.with({ type: "error" }, (e) => {
			sendError(ws, "openai_error", e.message ?? "upstream error");
			ws.close(1011, "openai_error");
			upstream.close(1000, "client closed");
		})
		.exhaustive();
}

function findRecordedToolResult(manifest: Map<number, TurnManifestEntry>, name: string): unknown {
	for (const turn of manifest.values()) {
		for (const r of turn.recordedToolResults) {
			if (r.name === name) return r.result;
		}
	}
	return undefined;
}

/**
 * xray sends recorded WAV bytes; OpenAI Realtime wants raw PCM16. Strip the
 * 44-byte canonical WAV header to get the sample data. This is a best-effort
 * decoder for the deterministic-WAV path; real-world WAV files with extended
 * headers or non-PCM16 encodings won't survive this transform — those would
 * need a real WAV parser (still out of scope for the contributor script).
 */
function pcm16WavToBase64Pcm(wavBase64: string): string {
	const bytes = Buffer.from(wavBase64, "base64");
	if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") {
		return wavBase64;
	}
	return bytes.subarray(44).toString("base64");
}

/**
 * Wrap an OpenAI Realtime PCM16/24k chunk in a canonical WAV header so xray
 * can land it as a playable .wav and the diff view can `<audio src=...>` it
 * without a transcoding step. Each chunk becomes a standalone WAV; on the
 * read side, xray concatenates all `agent_audio.delta` payloads — the first
 * chunk carries the header, subsequent chunks add raw samples (the player
 * tolerates the redundant headers in the stream because the data RIFF length
 * advertises a per-chunk size; for v1 the concatenated file may be slightly
 * "chunky" but is playable).
 */
function pcmToWavBase64(pcmBase64: string): string {
	const pcm = Buffer.from(pcmBase64, "base64");
	const sampleRate = 24_000;
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const dataLength = pcm.byteLength;
	const buffer = Buffer.alloc(44 + dataLength);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataLength, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(numChannels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bitsPerSample, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataLength, 40);
	pcm.copy(buffer, 44);
	return buffer.toString("base64");
}

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function sendError(ws: ServerWebSocket<PerSocketState>, code: string, message: string): void {
	if (ws.readyState !== WebSocket.OPEN) return;
	const frame: ServerFrame = { type: "error", code, message };
	ws.send(JSON.stringify(frame));
}

function parseArgs(argv: string[]): ScriptArgs {
	const out: ScriptArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined || !a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		let value: string;
		if (next !== undefined && !next.startsWith("--")) {
			value = next;
			i += 1;
		} else {
			value = "true";
		}
		if (key === "port" || key === "model" || key === "voice" || key === "system") {
			out[key] = value;
		}
	}
	return out;
}
