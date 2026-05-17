import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";
import { ws } from "msw";
import { safeParse } from "valibot";

import { server as mswServer } from "@/test-server.ts";

import type { ClientFrame, CreateRealtimeReplayRequest, ServerFrame } from "./realtime.types.ts";
import { ClientFrameSchema } from "./realtime.types.ts";

export function makeCreateRealtimeReplayRequest(
	overrides: Partial<CreateRealtimeReplayRequest> = {},
): CreateRealtimeReplayRequest {
	return {
		sourceSessionId: "sess-1",
		webhookUrl: "wss://example.test/realtime",
		...overrides,
	};
}

export function makeTempAudioRoot(): { path: string; dispose(): void } {
	const path = mkdtempSync(join(tmpdir(), "xray-realtime-test-"));
	return {
		path,
		dispose: () => rmSync(path, { recursive: true, force: true }),
	};
}

/**
 * Deterministic fake audio bytes — short, content-addressable per `(turnIdx,
 * seed)` so tests asserting "the bytes that landed on disk match the bytes
 * that went in" can pin exact values.
 */
export function fakeAudioBytes(seed: number, len = 64): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(len));
	for (let i = 0; i < len; i++) out[i] = (seed * 31 + i * 7) & 0xff;
	return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
	return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Spins up a real Bun WebSocket server on `port: 0` (free port). Each
 * connection's incoming frames are decoded through `ClientFrameSchema` and
 * appended to a per-connection list so tests can assert on what the engine
 * sent. The `respond` callback is called once per connection and is the
 * scripted webhook behavior — synchronous or async, sends `ServerFrame`s
 * back via `send(frame)`. The harness owns base64 codec + JSON, tests stay
 * focused on protocol behavior.
 */
export interface MockWebhookOptions {
	/** Called on every new connection. Use `conn.send(frame)` to push back. */
	onConnection: (conn: {
		readonly ws: ServerWebSocket<unknown>;
		readonly url: URL;
		readonly send: (frame: ServerFrame) => void;
		readonly close: (code?: number, reason?: string) => void;
		readonly frames: readonly ClientFrame[];
		/** Returns a promise that resolves the next time a client frame matching `predicate` arrives. */
		readonly waitFor: <T extends ClientFrame>(
			predicate: (frame: ClientFrame) => frame is T,
		) => Promise<T>;
	}) => void;
}

export interface MockWebhook {
	readonly url: string;
	stop(): Promise<void>;
}

interface MockSocketData {
	readonly url: URL;
	readonly frames: ClientFrame[];
	waiters: Array<{
		predicate: (frame: ClientFrame) => boolean;
		resolve: (frame: ClientFrame) => void;
	}>;
}

export function startMockWebhook(opts: MockWebhookOptions): MockWebhook {
	const server = Bun.serve<MockSocketData, never>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			const url = new URL(req.url);
			const data: MockSocketData = { url, frames: [], waiters: [] };
			const upgraded = srv.upgrade(req, { data });
			if (upgraded) return undefined;
			return new Response("not a websocket", { status: 400 });
		},
		websocket: {
			open(socket) {
				const state = socket.data;
				opts.onConnection({
					ws: socket,
					url: state.url,
					send: (frame) => {
						socket.send(JSON.stringify(frame));
					},
					close: (code = 1000, reason = "") => socket.close(code, reason),
					get frames() {
						return state.frames;
					},
					waitFor: <T extends ClientFrame>(predicate: (f: ClientFrame) => f is T) =>
						new Promise<T>((resolve) => {
							const hit = state.frames.find(predicate);
							if (hit !== undefined) {
								resolve(hit);
								return;
							}
							state.waiters.push({
								predicate,
								resolve: (f) => {
									// `predicate` guarantees the type at runtime; re-apply it
									// here so the resolve callback narrows without an `as` cast.
									if (predicate(f)) resolve(f);
								},
							});
						}),
				});
			},
			message(socket, raw) {
				const state = socket.data;
				const text = typeof raw === "string" ? raw : raw.toString("utf8");
				let json: unknown;
				try {
					json = JSON.parse(text);
				} catch {
					return;
				}
				const parsed = safeParse(ClientFrameSchema, json);
				if (!parsed.success) {
					// Test harness — surface the failure loudly so a misshapen
					// engine-side encoding fails the test instead of being swallowed.
					throw new Error(
						`MockWebhook received invalid ClientFrame: ${JSON.stringify(parsed.issues)}`,
					);
				}
				state.frames.push(parsed.output);
				const stillWaiting: typeof state.waiters = [];
				for (const w of state.waiters) {
					if (w.predicate(parsed.output)) w.resolve(parsed.output);
					else stillWaiting.push(w);
				}
				state.waiters = stillWaiting;
			},
		},
	});

	const port = server.port;
	const url = `ws://127.0.0.1:${port}/`;

	// MSW's experimental WebSocket interceptor catches every outbound `new
	// WebSocket(...)` from production code. We need our mock webhook to be
	// reachable, so register a per-URL link whose handler calls
	// `server.connect()` — that flips MSW into transparent-proxy mode for
	// this URL. Without this, every test sees the global setup's
	// `onUnhandledRequest: "error"` policy and the connection fails before
	// it leaves the test runner.
	mswServer.use(
		ws.link(url).addEventListener("connection", ({ server: realServer }) => {
			realServer.connect();
		}),
	);

	return {
		url,
		async stop() {
			// Non-forceful: `stop(true)` aborts open connections — but when MSW's
			// passthrough is in the loop it sometimes keeps a reference that
			// prevents that promise from resolving. The plain stop() closes the
			// listener and lets the connections drain on their own (they're
			// already closed at this point in every test).
			server.stop();
		},
	};
}

/**
 * For the "unreachable URL" test: we DO want MSW to passthrough so the OS
 * actually rejects the connection (instead of MSW masking the failure). Same
 * shape as above, just no Bun.serve started.
 */
export function passthroughWebhookUrl(url: string): void {
	mswServer.use(
		ws.link(url).addEventListener("connection", ({ server: realServer }) => {
			realServer.connect();
		}),
	);
}
