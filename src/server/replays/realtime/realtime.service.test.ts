import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { uploadTurnAudio } from "@/server/audio/audio.service.ts";
import { applyEvent } from "@/server/ingest/ingest.service.ts";
import {
	makeSessionStartedEvent,
	makeToolCalledEvent,
	makeTurnCompletedEvent,
} from "@/server/ingest/ingest.test-utils.ts";
import { getReplayRun } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { listToolCallsForSession } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";

import {
	TooManyToolCallsError,
	WebhookClosedEarlyError,
	WebhookInvalidFrameError,
	WebhookReportedError,
} from "./realtime.errors.ts";
import { createRealtimeReplay, runRealtimeReplay } from "./realtime.service.ts";
import {
	bytesToBase64,
	fakeAudioBytes,
	makeTempAudioRoot,
	passthroughWebhookUrl,
	startMockWebhook,
} from "./realtime.test-utils.ts";
import type { ClientFrame } from "./realtime.types.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;

beforeEach(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
});

afterEach(() => {
	store.close();
	audio.dispose();
});

async function seedSourceWithUserAudio(sessionId: string, turns: number): Promise<void> {
	applyEvent(store, sessionId, makeSessionStartedEvent({ agentId: "src-agent" }));
	for (let i = 0; i < turns; i++) {
		applyEvent(
			store,
			sessionId,
			makeTurnCompletedEvent({
				idx: i * 2,
				role: "user",
				text: `user message ${i}`,
				timestamp: `2026-05-17T12:0${i * 2}:00.000Z`,
			}),
		);
		applyEvent(
			store,
			sessionId,
			makeTurnCompletedEvent({
				idx: i * 2 + 1,
				role: "agent",
				text: `original agent reply ${i}`,
				timestamp: `2026-05-17T12:0${i * 2 + 1}:00.000Z`,
			}),
		);
		// Upload audio for the user turn so the engine has bytes to stream.
		await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx: i * 2,
			contentType: "audio/wav",
			bytes: fakeAudioBytes(i + 1, 256),
		});
	}
}

describe("createRealtimeReplay", () => {
	it("inserts a pending row with mode='realtime' and counts user turns as progress_total", async () => {
		await seedSourceWithUserAudio("src-1", 2);
		const row = createRealtimeReplay(store, {
			sourceSessionId: "src-1",
			webhookUrl: "ws://example.test/realtime",
		});
		expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(row.targetSessionId).toMatch(/^replay-[0-9a-f-]{36}$/);
		expect(row.status).toBe("pending");
		expect(row.progressTotal).toBe(2);
		const stored = getReplayRun(store.db, row.id);
		expect(stored?.mode).toBe("realtime");
	});
});

describe("runRealtimeReplay — happy path", () => {
	it("streams user audio chunks then writes agent audio + transcript per turn", async () => {
		await seedSourceWithUserAudio("src-1", 2);

		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				const start = await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "session.start" }> => f.type === "session.start",
				);
				const userTurns = start.turns.filter((t) => t.role === "user");
				for (const t of userTurns) {
					await conn.waitFor(
						(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
							f.type === "user_audio.commit" && f.turnIdx === t.turnIdx,
					);
					// Send a tiny agent audio reply + transcript + done.
					conn.send({
						type: "agent_audio.delta",
						turnIdx: t.turnIdx,
						contentType: "audio/wav",
						audioBase64: bytesToBase64(fakeAudioBytes(100 + t.turnIdx, 32)),
					});
					conn.send({
						type: "turn.done",
						turnIdx: t.turnIdx,
						transcript: `agent replay for ${t.text}`,
						responseLatencyMs: 150,
					});
				}
			},
		});

		try {
			const { id, targetSessionId } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await runRealtimeReplay({ store, audioRoot: audio.path, runId: id });

			const run = getReplayRun(store.db, id);
			expect(run?.status).toBe("completed");
			expect(run?.progressCompleted).toBe(2);
			expect(run?.error).toBeNull();

			const turns = listTurnsForSession(store.db, targetSessionId);
			expect(turns.map((t) => t.role)).toEqual(["user", "agent", "user", "agent"]);
			const agentTurns = turns.filter((t) => t.role === "agent");
			expect(agentTurns.map((t) => t.text)).toEqual([
				"agent replay for user message 0",
				"agent replay for user message 1",
			]);
			expect(agentTurns.map((t) => t.responseLatencyMs)).toEqual([150, 150]);
			// Each agent turn has an audio_path stamped.
			for (const t of agentTurns) {
				expect(t.audioPath).not.toBeNull();
				const bytes = await readFile(join(audio.path, t.audioPath ?? ""));
				expect(bytes.length).toBeGreaterThan(0);
			}
		} finally {
			await webhook.stop();
		}
	});

	it("forwards every recorded user-audio byte to the webhook, base64-encoded", async () => {
		await seedSourceWithUserAudio("src-1", 1);
		const expectedBytes = fakeAudioBytes(1, 256);

		let appendedBase64 = "";
		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "session.start" }> => f.type === "session.start",
				);
				const commit = await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				for (const f of conn.frames) {
					if (f.type === "user_audio.append" && f.turnIdx === commit.turnIdx) {
						appendedBase64 += f.audioBase64;
					}
				}
				conn.send({
					type: "turn.done",
					turnIdx: commit.turnIdx,
					transcript: "ok",
				});
			},
		});

		try {
			const { id } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await runRealtimeReplay({ store, audioRoot: audio.path, runId: id });

			expect(Buffer.from(appendedBase64, "base64")).toEqual(Buffer.from(expectedBytes));
		} finally {
			await webhook.stop();
		}
	});
});

describe("runRealtimeReplay — tools", () => {
	it("includes the source's recorded tool results in the session.start manifest", async () => {
		applyEvent(store, "src-1", makeSessionStartedEvent({ agentId: "x" }));
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 0, role: "user", text: "weather pls" }),
		);
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 1, role: "agent", text: "let me check" }),
		);
		applyEvent(
			store,
			"src-1",
			makeToolCalledEvent({
				turnIdx: 1,
				idx: 0,
				name: "get_weather",
				args: { city: "Paris" },
				result: { temp: 22 },
			}),
		);
		await uploadTurnAudio(store, audio.path, {
			sessionId: "src-1",
			turnIdx: 0,
			contentType: "audio/wav",
			bytes: fakeAudioBytes(1, 32),
		});

		let seenManifest: unknown;
		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				const start = await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "session.start" }> => f.type === "session.start",
				);
				seenManifest = start.turns;
				await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				conn.send({ type: "turn.done", turnIdx: 0, transcript: "ok" });
			},
		});

		try {
			const { id } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await runRealtimeReplay({ store, audioRoot: audio.path, runId: id });
		} finally {
			await webhook.stop();
		}

		expect(seenManifest).toEqual([
			{
				turnIdx: 0,
				role: "user",
				text: "weather pls",
				audioContentType: "audio/wav",
				recordedToolResults: [],
			},
			{
				turnIdx: 1,
				role: "agent",
				text: "let me check",
				audioContentType: null,
				recordedToolResults: [
					{ name: "get_weather", args: { city: "Paris" }, result: { temp: 22 } },
				],
			},
		]);
	});

	it("persists tool_called frames from the webhook into the target session", async () => {
		await seedSourceWithUserAudio("src-1", 1);

		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				const commit = await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				conn.send({
					type: "tool_called",
					turnIdx: commit.turnIdx,
					idx: 0,
					name: "get_weather",
					args: { city: "London" },
					result: { temp: 15 },
				});
				conn.send({ type: "turn.done", turnIdx: commit.turnIdx, transcript: "it's 15C" });
			},
		});

		try {
			const { id, targetSessionId } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await runRealtimeReplay({ store, audioRoot: audio.path, runId: id });

			const calls = listToolCallsForSession(store.db, targetSessionId);
			expect(calls.map((c) => c.name)).toEqual(["get_weather"]);
			expect(calls.map((c) => JSON.parse(c.argsJson))).toEqual([{ city: "London" }]);
			const first = calls[0];
			expect(first).toBeDefined();
			expect(first?.resultJson === null ? null : JSON.parse(first?.resultJson ?? "null")).toEqual({
				temp: 15,
			});
		} finally {
			await webhook.stop();
		}
	});
});

describe("runRealtimeReplay — failure modes", () => {
	it("marks the run failed and surfaces the close info when the webhook closes mid-session", async () => {
		await seedSourceWithUserAudio("src-1", 2);

		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				// Complete first turn — then slam the socket shut before turn 1 finishes.
				conn.send({ type: "turn.done", turnIdx: 0, transcript: "first ok" });
				conn.close(1011, "simulated provider crash");
			},
		});

		try {
			const { id, targetSessionId } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});

			await expect(runRealtimeReplay({ store, audioRoot: audio.path, runId: id })).rejects.toThrow(
				WebhookClosedEarlyError,
			);

			const run = getReplayRun(store.db, id);
			expect(run?.status).toBe("failed");
			expect(run?.error).toContain("1011");

			// First turn's user + agent rows should exist; second turn's must NOT —
			// no partial turns leak into the target session.
			const turns = listTurnsForSession(store.db, targetSessionId);
			expect(turns.map((t) => t.text)).toEqual(["user message 0", "first ok"]);
		} finally {
			await webhook.stop();
		}
	});

	it("marks the run failed when the webhook emits a malformed frame", async () => {
		await seedSourceWithUserAudio("src-1", 1);

		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				// Send a frame with a known type but a malformed payload.
				conn.ws.send(JSON.stringify({ type: "turn.done", turnIdx: 0 }));
			},
		});

		try {
			const { id } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});

			await expect(runRealtimeReplay({ store, audioRoot: audio.path, runId: id })).rejects.toThrow(
				WebhookInvalidFrameError,
			);

			expect(getReplayRun(store.db, id)?.status).toBe("failed");
		} finally {
			await webhook.stop();
		}
	});

	it("marks the run failed when the webhook reports a protocol-level error", async () => {
		await seedSourceWithUserAudio("src-1", 1);

		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "session.start" }> => f.type === "session.start",
				);
				conn.send({ type: "error", code: "no_api_key", message: "OPENAI_API_KEY not set" });
				conn.close(1011, "no_api_key");
			},
		});

		try {
			const { id } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});

			await expect(runRealtimeReplay({ store, audioRoot: audio.path, runId: id })).rejects.toThrow(
				WebhookReportedError,
			);

			const run = getReplayRun(store.db, id);
			expect(run?.status).toBe("failed");
			expect(run?.error).toContain("no_api_key");
		} finally {
			await webhook.stop();
		}
	});

	it("marks the run failed when the webhook URL cannot be reached", async () => {
		await seedSourceWithUserAudio("src-1", 1);
		const url = "ws://127.0.0.1:1/";
		passthroughWebhookUrl(url);
		const { id } = createRealtimeReplay(store, {
			sourceSessionId: "src-1",
			// Port 1 is reserved + unbound; the OS rejects immediately.
			webhookUrl: url,
		});

		// Bun WebSocket surfaces an unreachable-host failure as a close-with-1006
		// rather than throwing in the constructor, so the engine reports it
		// through the "closed early" path. Either failure shape is acceptable;
		// the contract the operator cares about is "run ends up in 'failed' with
		// an error message that explains why".
		await expect(
			runRealtimeReplay({ store, audioRoot: audio.path, runId: id }),
		).rejects.toMatchObject({ name: expect.stringMatching(/Webhook(Connect|ClosedEarly)Error/) });

		const run = getReplayRun(store.db, id);
		expect(run?.status).toBe("failed");
		expect(run?.error?.length ?? 0).toBeGreaterThan(0);
	});
});

describe("runRealtimeReplay — edge cases", () => {
	it("completes a source session with no user turns by emitting an empty target", async () => {
		applyEvent(store, "src-1", makeSessionStartedEvent({ agentId: "x" }));
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 0, role: "agent", text: "monologue" }),
		);

		// Webhook receives session.start with empty manifest; immediately session.end.
		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				await conn.waitFor((f): f is ClientFrame => f.type === "session.end");
			},
		});

		try {
			const { id, targetSessionId } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await runRealtimeReplay({ store, audioRoot: audio.path, runId: id });

			expect(getReplayRun(store.db, id)?.status).toBe("completed");
			expect(getReplayRun(store.db, id)?.progressCompleted).toBe(0);
			expect(listTurnsForSession(store.db, targetSessionId)).toEqual([]);
		} finally {
			await webhook.stop();
		}
	});

	it("throws TooManyToolCallsError once the per-turn tool_called count exceeds the cap", async () => {
		await seedSourceWithUserAudio("src-1", 1);
		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				const commit = await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				// MAX_REALTIME_TOOL_CALLS_PER_TURN = 64. Push 65 to trip the cap.
				for (let i = 0; i < 65; i++) {
					conn.send({
						type: "tool_called",
						turnIdx: commit.turnIdx,
						idx: i,
						name: "spam",
						args: { i },
					});
				}
			},
		});
		try {
			const { id } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await expect(runRealtimeReplay({ store, audioRoot: audio.path, runId: id })).rejects.toThrow(
				TooManyToolCallsError,
			);
			expect(getReplayRun(store.db, id)?.status).toBe("failed");
		} finally {
			await webhook.stop();
		}
	});

	it("tolerates a source user turn with no recorded audio (zero append frames)", async () => {
		applyEvent(store, "src-1", makeSessionStartedEvent({ agentId: "x" }));
		applyEvent(
			store,
			"src-1",
			makeTurnCompletedEvent({ idx: 0, role: "user", text: "no audio here" }),
		);
		// No uploadTurnAudio — turn has audioPath === null.

		const webhook = startMockWebhook({
			onConnection: async (conn) => {
				const commit = await conn.waitFor(
					(f): f is Extract<ClientFrame, { type: "user_audio.commit" }> =>
						f.type === "user_audio.commit",
				);
				const appendCount = conn.frames.filter(
					(f) => f.type === "user_audio.append" && f.turnIdx === commit.turnIdx,
				).length;
				expect(appendCount).toBe(0);
				conn.send({ type: "turn.done", turnIdx: commit.turnIdx, transcript: "fine" });
			},
		});

		try {
			const { id, targetSessionId } = createRealtimeReplay(store, {
				sourceSessionId: "src-1",
				webhookUrl: webhook.url,
			});
			await runRealtimeReplay({ store, audioRoot: audio.path, runId: id });

			expect(getReplayRun(store.db, id)?.status).toBe("completed");
			const turns = listTurnsForSession(store.db, targetSessionId);
			expect(turns.map((t) => t.role)).toEqual(["user", "agent"]);
			expect(turns.map((t) => t.text)).toEqual(["no audio here", "fine"]);
		} finally {
			await webhook.stop();
		}
	});
});
