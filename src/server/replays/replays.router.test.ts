import { Hono } from "hono";
import * as v from "valibot";

import { createConversationsRouter } from "@/server/conversations/conversations.router.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { readJson } from "@/server/core/test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createReplaysRouter } from "./replays.router.ts";
import { makeCreateReplayRequest, seedReplay } from "./replays.test-utils.ts";
import { describe, expect, it } from "bun:test";

function makeApp() {
	const store = makeTempStore();
	const app = new Hono();
	app.route("/v1", createConversationsRouter(store));
	app.route("/v1", createReplaysRouter(store));
	return { app, store };
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
	it("returns 201 + a running detail row", async () => {
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
		const body = await readJson(res, v.object({ status: v.string(), id: v.string() }));
		expect(body.status).toBe("running");
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
	it("updates status + judge + finished_at", async () => {
		const { app, store } = makeApp();
		const id = seedReplay(store);
		const res = await app.request(`/v1/replays/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "completed",
				finished_at: "2026-05-18T12:05:00.000Z",
				judge: { status: "passed", score: 92 },
			}),
		});
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({ status: v.string(), judge: v.object({ score: v.number() }) }),
		);
		expect(body.status).toBe("completed");
		expect(body.judge.score).toBe(92);
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/00000000-0000-0000-0000-000000000099", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "completed" }),
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid id shape", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/replays/not-a-uuid", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "completed" }),
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
