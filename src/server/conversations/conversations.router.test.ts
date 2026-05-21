import { Hono } from "hono";
import * as v from "valibot";

import { readJson } from "@/server/core/test-utils.ts";
import {
	createReplayForTest,
	makeCreateReplayRequest,
} from "@/server/replays/replays.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createConversationsRouter } from "./conversations.router.ts";
import { describe, expect, it } from "bun:test";

function makeApp() {
	const store = makeTempStore();
	const app = new Hono().route("/v1", createConversationsRouter(store));
	return { app, store };
}

describe("GET /v1/conversations", () => {
	it("returns one row per content hash", async () => {
		const { app, store } = makeApp();
		await createReplayForTest(
			store,
			makeCreateReplayRequest({
				name: "alpha",
				turns: [
					{ role: "user", text: "hi", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		await createReplayForTest(
			store,
			makeCreateReplayRequest({
				name: "beta",
				turns: [
					{ role: "user", text: "bye", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const res = await app.request("/v1/conversations");
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({
				items: v.array(v.object({ hash: v.string(), name: v.string(), replays: v.number() })),
			}),
		);
		expect(body.items).toHaveLength(2);
		expect(body.items.every((i) => i.replays === 1)).toBe(true);
		expect(body.items.map((i) => i.name).sort()).toEqual(["alpha", "beta"]);
	});
});

describe("GET /v1/conversations/:hash", () => {
	it("returns the conversation row", async () => {
		const { app, store } = makeApp();
		const detail = await createReplayForTest(store, makeCreateReplayRequest({ name: "x" }));
		const hash = detail.conversation_hash;
		const res = await app.request(`/v1/conversations/${hash}`);
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ hash: v.string(), name: v.string() }));
		expect(body.hash).toBe(hash);
		expect(body.name).toBe("x");
	});

	it("returns 404 for unknown hash", async () => {
		const { app } = makeApp();
		const res = await app.request(`/v1/conversations/${"f".repeat(64)}`);
		expect(res.status).toBe(404);
	});

	it("returns 400 for a malformed hash", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations/not-a-hash");
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/conversations/:hash/replays", () => {
	it("returns replays attached to the hash", async () => {
		const { app, store } = makeApp();
		const turns = [
			{ role: "user" as const, text: "hi", key: "u0" },
			{ role: "agent" as const, key: "a0" },
		];
		const first = await createReplayForTest(store, makeCreateReplayRequest({ name: "n", turns }));
		await createReplayForTest(store, makeCreateReplayRequest({ name: "n", turns }));
		const res = await app.request(`/v1/conversations/${first.conversation_hash}/replays`);
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ items: v.array(v.unknown()) }));
		expect(body.items).toHaveLength(2);
	});

	it("returns 404 for unknown hash", async () => {
		const { app } = makeApp();
		const res = await app.request(`/v1/conversations/${"e".repeat(64)}/replays`);
		expect(res.status).toBe(404);
	});
});
