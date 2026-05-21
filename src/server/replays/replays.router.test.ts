import { Hono } from "hono";
import * as v from "valibot";

import { createConversationsRouter } from "@/server/conversations/conversations.router.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { readJson } from "@/server/core/test-utils.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { makeReplayEvents } from "./replays.events.ts";
import { createReplaysRouter } from "./replays.router.ts";
import { makeCreateReplayRequest, seedReplay } from "./replays.test-utils.ts";
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
			if (buf.includes("event: completed")) break;
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
	app.route("/v1", createConversationsRouter(store));
	app.route("/v1", createReplaysRouter(store, jobRunner, events));
	return { app, store, jobRunner, events };
}

async function postConversation(app: Hono, id: string, version = "v1") {
	const res = await app.request("/v1/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(makeConversationSpec({ id, version })),
	});
	expect(res.status).toBe(200);
}

describe("POST /v1/replays", () => {
	it("returns 201 + a pending detail row", async () => {
		const { app } = makeApp();
		await postConversation(app, "c");
		const res = await app.request("/v1/replays", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(
				makeCreateReplayRequest({ conversation_id: "c", conversation_version: "v1" }),
			),
		});
		expect(res.status).toBe(201);
		const body = await readJson(res, v.object({ lifecycle_state: v.string(), id: v.string() }));
		expect(body.lifecycle_state).toBe("pending");
		expect(body.id).toMatch(/[0-9a-f-]{36}/);
	});

	it("returns 404 when the conversation doesn't exist", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(
				makeCreateReplayRequest({ conversation_id: "missing", conversation_version: "v1" }),
			),
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 on bad body", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversation_id: "" }),
		});
		expect(res.status).toBe(400);
	});
});

describe("PATCH /v1/replays/:id", () => {
	it("updates lifecycle_state + finished_at", async () => {
		const { app, store } = makeApp();
		const id = seedReplay(store);
		const res = await app.request(`/v1/replays/${id}`, {
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
		const id = seedReplay(store);
		const res = await app.request(`/v1/replays/${id}`);
		expect(res.status).toBe(200);
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099");
		expect(res.status).toBe(404);
	});
});

describe("GET /v1/replays/:id/events (SSE)", () => {
	it("delivers an event emitted right after the request opens (subscribe-before-write race fix)", async () => {
		const { app, store, events } = makeApp();
		const id = seedReplay(store);

		const res = await app.request(`/v1/replays/${id}/events`);
		expect(res.status).toBe(200);
		expect(res.body).not.toBeNull();
		const body = res.body;
		if (body === null) throw new Error("missing SSE body");

		// `app.request` resolves once the handler's response is shaped (status +
		// headers); the body stream stays open. By this point the SSE handler
		// must have already subscribed — otherwise this emit lands with zero
		// listeners and the test reads only the initial state.
		events.emit(id, { type: "progress", percent: 10, step: "vad" });
		events.emit(id, { type: "state", lifecycle_state: "completed", analysis_step: null });
		events.emit(id, { type: "completed", turns_written: 1, segments_written: 2 });

		const text = await readSseUntilCompleted(body);
		expect(text).toContain('"lifecycle_state":"pending"'); // initial
		expect(text).toContain('"percent":10'); // emitted progress
		expect(text).toContain('"lifecycle_state":"completed"'); // emitted state
		expect(text).toContain('"turns_written":1'); // emitted completed
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099/events");
		expect(res.status).toBe(404);
	});

	it("unsubscribes the listener after a terminal event (no leak in ReplayEvents)", async () => {
		const { app, store, events } = makeApp();
		const id = seedReplay(store);

		const res = await app.request(`/v1/replays/${id}/events`);
		expect(res.status).toBe(200);
		const body = res.body;
		if (body === null) throw new Error("missing SSE body");

		// One listener attached after the handler subscribes.
		// Drain the response body so the handler progresses past the awaited
		// initial-state write into the live loop.
		events.emit(id, { type: "completed", turns_written: 0, segments_written: 0 });
		await readSseUntilCompleted(body);

		// Give the handler's done.promise resolution + final cleanup a tick.
		await new Promise((r) => setTimeout(r, 10));
		expect(events.listenerCount(id)).toBe(0);
	});
});

describe("POST /v1/replays/:id/analyze", () => {
	it("returns 202 + job_id when the replay is in recording_uploaded state", async () => {
		const { app, store, jobRunner } = makeApp();
		const id = seedReplay(store);
		// Flip to recording_uploaded via direct SQL update (audio router does this
		// in production after POST /audio).
		const { replays } = await import("@/server/store/schema.ts");
		const { eq } = await import("drizzle-orm");
		store.db
			.update(replays)
			.set({ lifecycleState: "recording_uploaded", audioPath: "x/replay.wav" })
			.where(eq(replays.id, id))
			.run();

		const res = await app.request(`/v1/replays/${id}/analyze`, { method: "POST" });
		expect(res.status).toBe(202);
		const body = await readJson(res, v.object({ job_id: v.string(), lifecycle_state: v.string() }));
		expect(body.lifecycle_state).toBe("analyzing");
		expect(jobRunner.enqueued).toHaveLength(1);
		expect(jobRunner.enqueued[0]?.replayId).toBe(id);
	});

	it("returns 409 when the replay is not in recording_uploaded state", async () => {
		const { app, store } = makeApp();
		const id = seedReplay(store);
		const res = await app.request(`/v1/replays/${id}/analyze`, { method: "POST" });
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
		const a = seedReplay(store, { id: "00000000-0000-0000-0000-00000000000a" });
		const b = seedReplay(store, { id: "00000000-0000-0000-0000-00000000000b" });
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
		const id = seedReplay(store);
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: [id] }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 when too many ids", async () => {
		const { app, store } = makeApp();
		const ids = Array.from({ length: 9 }, (_, i) =>
			seedReplay(store, {
				id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
			}),
		);
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: ids }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 404 when one of the ids does not exist", async () => {
		const { app, store } = makeApp();
		const a = seedReplay(store, { id: "00000000-0000-0000-0000-00000000000a" });
		const res = await app.request("/v1/replays/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ replay_ids: [a, "00000000-0000-0000-0000-00000000000b"] }),
		});
		expect(res.status).toBe(404);
	});
});
