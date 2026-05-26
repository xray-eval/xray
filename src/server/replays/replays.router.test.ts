import { Hono } from "hono";
import * as v from "valibot";

import { seedConversation } from "@/server/conversations/conversations.test-utils.ts";
import { readJson } from "@/server/core/test-utils.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { makeReplayEvents } from "./replays.events.ts";
import { createReplaysRouter } from "./replays.router.ts";
import { seedReplay } from "./replays.test-utils.ts";
import { describe, expect, it } from "bun:test";

async function readSseUntilCompleted(
	body: ReadableStream<Uint8Array>,
	timeoutMs = 3_000,
): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buf = "";
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			if (buf.includes("event: evaluation_complete") || buf.includes("event: failed")) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return buf;
}

function makeApp() {
	const store = makeTempStore();
	const jobRunner = makeFakeJobRunner();
	const events = makeReplayEvents();
	const app = new Hono();
	app.route("/v1", createReplaysRouter(store, jobRunner, events));
	return { app, store, jobRunner, events };
}

describe("POST /v1/replays", () => {
	it("returns 201 + a pending detail row", async () => {
		const { app, store } = makeApp();
		const { hash } = await seedConversation(store);
		const res = await app.request("/v1/replays", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversation_hash: hash }),
		});
		expect(res.status).toBe(201);
		const body = await readJson(res, v.object({ lifecycle_state: v.string(), id: v.string() }));
		expect(body.lifecycle_state).toBe("pending");
		expect(body.id).toMatch(/[0-9a-f-]{36}/);
	});

	it("returns 404 when the conversation hash doesn't exist", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversation_hash: "f".repeat(64) }),
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 on bad body", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversation_hash: "" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("PATCH /v1/replays/:id", () => {
	it("updates lifecycle_state + finished_at", async () => {
		const { app, store } = makeApp();
		const { replayId } = await seedReplay(store);
		const res = await app.request(`/v1/replays/${replayId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				lifecycle_state: "running",
				finished_at: null,
			}),
		});
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ lifecycle_state: v.string() }));
		expect(body.lifecycle_state).toBe("running");
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lifecycle_state: "running" }),
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid id shape", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/not-a-uuid", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ lifecycle_state: "running" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/replays/:id", () => {
	it("returns 200 detail for a known id", async () => {
		const { app, store } = makeApp();
		const { replayId } = await seedReplay(store);
		const res = await app.request(`/v1/replays/${replayId}`);
		expect(res.status).toBe(200);
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099");
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/replays/:id/events (SSE)", () => {
	it("delivers an event emitted right after the request opens", async () => {
		const { app, store, events } = makeApp();
		const { replayId } = await seedReplay(store);

		const res = await app.request(`/v1/replays/${replayId}/events`);
		expect(res.status).toBe(200);
		expect(res.body).not.toBeNull();
		const body = res.body;
		if (body === null) throw new Error("missing SSE body");

		events.emit(replayId, { type: "progress", percent: 10, step: "vad" });
		events.emit(replayId, { type: "state", lifecycle_state: "completed", analysis_step: null });
		events.emit(replayId, {
			type: "evaluation_complete",
			result: {
				replay_id: replayId,
				conversation_hash: "a".repeat(64),
				passed: true,
				assertions: [],
				judges: [],
				metrics: { turns: [] },
			},
		});

		const text = await readSseUntilCompleted(body);
		expect(text).toContain('"lifecycle_state":"pending"');
		expect(text).toContain('"percent":10');
		expect(text).toContain('"lifecycle_state":"completed"');
		expect(text).toContain('"evaluation_complete"');
		expect(text).toContain('"passed":true');
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099/events");
		expect(res.status).toBe(404);
	});

	it("unsubscribes the listener after a terminal event", async () => {
		const { app, store, events } = makeApp();
		const { replayId } = await seedReplay(store);

		const res = await app.request(`/v1/replays/${replayId}/events`);
		expect(res.status).toBe(200);
		const body = res.body;
		if (body === null) throw new Error("missing SSE body");

		events.emit(replayId, {
			type: "evaluation_complete",
			result: {
				replay_id: replayId,
				conversation_hash: "a".repeat(64),
				passed: true,
				assertions: [],
				judges: [],
				metrics: { turns: [] },
			},
		});
		await readSseUntilCompleted(body);

		await new Promise((r) => setTimeout(r, 10));
		expect(events.listenerCount(replayId)).toBe(0);
	});
});

describe("POST /v1/replays/:id/analyze", () => {
	it("returns 202 + job_id when the replay is in recording_uploaded state", async () => {
		const { app, store, jobRunner } = makeApp();
		const { replayId } = await seedReplay(store);
		const { replays } = await import("@/server/store/schema.ts");
		const { eq } = await import("drizzle-orm");
		store.db
			.update(replays)
			.set({ lifecycleState: "recording_uploaded", audioPath: "x/replay.wav" })
			.where(eq(replays.id, replayId))
			.run();

		const res = await app.request(`/v1/replays/${replayId}/analyze`, { method: "POST" });
		expect(res.status).toBe(202);
		const body = await readJson(res, v.object({ job_id: v.string(), lifecycle_state: v.string() }));
		expect(body.lifecycle_state).toBe("analyzing");
		expect(jobRunner.enqueued).toHaveLength(1);
		expect(jobRunner.enqueued[0]?.name).toBe("analyze-replay");
		expect(jobRunner.enqueued[0]?.payload.replayId).toBe(replayId);
	});

	it("returns 409 when the replay is not in recording_uploaded state", async () => {
		const { app, store } = makeApp();
		const { replayId } = await seedReplay(store);
		const res = await app.request(`/v1/replays/${replayId}/analyze`, { method: "POST" });
		expect(res.status).toBe(409);
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099/analyze", {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});
});

describe("POST /v1/replays/compare", () => {
	it("returns 200 with replays in request order", async () => {
		const { app, store } = makeApp();
		const { replayId: a } = await seedReplay(store, {
			id: "00000000-0000-0000-0000-00000000000a",
		});
		const { replayId: b } = await seedReplay(store, {
			id: "00000000-0000-0000-0000-00000000000b",
		});
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: [b, a] }),
		});
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ replays: v.array(v.object({ id: v.string() })) }));
		expect(body.replays.map((r) => r.id)).toEqual([b, a]);
	});

	it("returns 400 when too few ids", async () => {
		const { app, store } = makeApp();
		const { replayId } = await seedReplay(store);
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: [replayId] }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when too many ids", async () => {
		const { app, store } = makeApp();
		const ids: string[] = [];
		for (let i = 0; i < 9; i += 1) {
			const { replayId } = await seedReplay(store, {
				id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
			});
			ids.push(replayId);
		}
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: ids }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 404 when one of the ids does not exist", async () => {
		const { app, store } = makeApp();
		const { replayId: a } = await seedReplay(store, {
			id: "00000000-0000-0000-0000-00000000000a",
		});
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: [a, "00000000-0000-0000-0000-00000000000b"] }),
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/replays/:id/result", () => {
	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099/result");
		expect(res.status).toBe(404);
	});

	it("returns 409 when the replay hasn't reached a terminal state", async () => {
		// `pending` (the default seed state) has no ReplayResult to project.
		const { app, store } = makeApp();
		const { replayId } = await seedReplay(store);
		const res = await app.request(`/v1/replays/${replayId}/result`);
		expect(res.status).toBe(409);
	});

	it("returns 200 + the projected ReplayResult once the analyze chain has finished", async () => {
		// Seed the five tables the projection joins:
		//   replay_evaluations (verdict + counts)
		//   assertion_results / judge_results (per-row outcomes)
		//   replay_turns + replay_metrics (per-turn metrics)
		// Then flip the replay row to `completed` so the endpoint accepts it.
		const { app, store } = makeApp();
		const { replayId } = await seedReplay(store);
		const evaluatedAt = "2026-05-18T12:30:00.000Z";
		const {
			assertionResults,
			judgeResults,
			replayEvaluations,
			replayMetrics,
			replayTurns,
			replays: replaysTable,
		} = await import("@/server/store/schema.ts");
		const { eq } = await import("drizzle-orm");

		store.db
			.update(replaysTable)
			.set({ lifecycleState: "completed", finishedAt: evaluatedAt })
			.where(eq(replaysTable.id, replayId))
			.run();
		store.db
			.insert(replayTurns)
			.values([
				{
					replayId,
					idx: 0,
					role: "user",
					turnStartMs: 0,
					turnEndMs: 1000,
					voiceStartMs: 0,
					voiceEndMs: 1000,
				},
				{
					replayId,
					idx: 1,
					role: "agent",
					turnStartMs: 1000,
					turnEndMs: 2000,
					voiceStartMs: 1100,
					voiceEndMs: 2000,
				},
			])
			.run();
		store.db
			.insert(replayMetrics)
			.values([
				{
					replayId,
					turnIdx: 1,
					agentResponseMs: 100,
					ttftMs: 50,
					interrupted: false,
					interruptionStartMs: null,
				},
			])
			.run();
		store.db
			.insert(assertionResults)
			.values([
				{
					replayId,
					turnIdx: 1,
					assertionIdx: 0,
					kind: "contains",
					paramsJson: JSON.stringify({ kind: "contains", text: "hi" }),
					status: "passed",
					message: null,
					evaluatedAt,
				},
			])
			.run();
		store.db
			.insert(judgeResults)
			.values([
				{
					replayId,
					judgeIdx: 0,
					kind: "text_match",
					paramsJson: JSON.stringify({ kind: "text_match", reference: "x", pass_score: 70 }),
					status: "passed",
					score: 92,
					reason: "ok",
					provider: "fake",
					model: "fake-1",
					evaluatedAt,
				},
			])
			.run();
		store.db
			.insert(replayEvaluations)
			.values({
				replayId,
				passed: true,
				assertionsTotal: 1,
				assertionsPassed: 1,
				judgesTotal: 1,
				judgesPassed: 1,
				evaluatedAt,
			})
			.run();

		const res = await app.request(`/v1/replays/${replayId}/result`);
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({
				replay_id: v.string(),
				conversation_hash: v.string(),
				passed: v.boolean(),
				assertions: v.array(
					v.object({ turn_idx: v.number(), kind: v.string(), status: v.string() }),
				),
				judges: v.array(v.object({ judge_idx: v.number(), kind: v.string(), status: v.string() })),
				metrics: v.object({
					turns: v.array(v.object({ turn_idx: v.number(), role: v.string() })),
				}),
			}),
		);
		expect(body.replay_id).toBe(replayId);
		expect(body.passed).toBe(true);
		expect(body.assertions.length).toBe(1);
		expect(body.judges.length).toBe(1);
		expect(body.metrics.turns.length).toBe(2);
	});
});
