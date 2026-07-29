import { Hono } from "hono";
import * as v from "valibot";

import { readJson } from "@/server/core/test-utils.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createRunConfigsRouter } from "./run-configs.router.ts";
import { seedGroupedReplay } from "./run-configs.test-utils.ts";
import { beforeEach, describe, expect, it } from "bun:test";

let store: Store;
let app: Hono;

beforeEach(() => {
	store = makeTempStore();
	app = new Hono();
	app.route("/v1", createRunConfigsRouter(store));
});

const CONV_A = "a".repeat(64);
const CONV_B = "b".repeat(64);

function seedTwoConfigs(): { baseline: string; fast: string } {
	const baseline = seedGroupedReplay(store, {
		id: "base-a",
		conversationHash: CONV_A,
		conversationName: "alpha",
		config: { model: "gpt-4o" },
		configName: "baseline",
		startedAt: "2026-07-01T00:00:00.000Z",
		agentTurns: [{ agentResponseMs: 400 }],
		modelCalls: [{ ttftMs: 300, latencyMs: 900 }],
		passed: true,
	});
	const fast = seedGroupedReplay(store, {
		id: "fast-a",
		conversationHash: CONV_A,
		config: { model: "gemini-2.5-flash" },
		configName: "fast-follow",
		startedAt: "2026-07-02T00:00:00.000Z",
		agentTurns: [{ agentResponseMs: 200 }],
		passed: true,
	});
	seedGroupedReplay(store, {
		id: "fast-b",
		conversationHash: CONV_B,
		config: { model: "gemini-2.5-flash" },
		startedAt: "2026-07-02T01:00:00.000Z",
		agentTurns: [{ agentResponseMs: 300 }],
		passed: false,
	});
	return { baseline, fast };
}

describe("GET /v1/run-configs", () => {
	it("lists groups with their coverage", async () => {
		seedTwoConfigs();
		const res = await app.request("/v1/run-configs");
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({
				items: v.array(
					v.object({
						hash: v.string(),
						name: v.nullable(v.string()),
						coverage: v.object({ conversations: v.number(), replays: v.number() }),
					}),
				),
			}),
		);
		expect(body.items).toHaveLength(2);
		expect(body.items[0]?.name).toBe("fast-follow");
		expect(body.items[0]?.coverage).toMatchObject({ conversations: 2, replays: 2 });
	});

	it("returns an empty list rather than 404 when nothing has run", async () => {
		const res = await app.request("/v1/run-configs");
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ items: v.array(v.unknown()) }));
		expect(body.items).toEqual([]);
	});
});

describe("POST /v1/run-configs/compare", () => {
	it("returns one group per requested hash, in order", async () => {
		const { baseline, fast } = seedTwoConfigs();
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config_hashes: [baseline, fast] }),
		});
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({
				replay_selection: v.string(),
				conversation_scope: v.string(),
				union_conversations: v.number(),
				groups: v.array(v.object({ hash: v.string() })),
			}),
		);
		expect(body.groups.map((g) => g.hash)).toEqual([baseline, fast]);
		expect(body.replay_selection).toBe("latest");
		expect(body.conversation_scope).toBe("union");
		expect(body.union_conversations).toBe(2);
	});

	it("honours the intersection scope", async () => {
		const { baseline, fast } = seedTwoConfigs();
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				config_hashes: [baseline, fast],
				conversation_scope: "intersection",
			}),
		});
		const body = await readJson(
			res,
			v.object({
				conversation_scope: v.string(),
				intersection_conversations: v.number(),
				groups: v.array(v.object({ coverage: v.object({ conversations: v.number() }) })),
			}),
		);
		expect(body.conversation_scope).toBe("intersection");
		expect(body.intersection_conversations).toBe(1);
		expect(body.groups[1]?.coverage.conversations).toBe(1);
	});

	it("rejects a single hash — there is nothing to compare against", async () => {
		const { baseline } = seedTwoConfigs();
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config_hashes: [baseline] }),
		});
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_run_config_request");
	});

	it("rejects more hashes than the compare cap", async () => {
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				config_hashes: Array.from({ length: 9 }, (_, i) => String(i).repeat(64).slice(0, 64)),
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a repeated hash — two identical columns read as agreeing results", async () => {
		const { baseline } = seedTwoConfigs();
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config_hashes: [baseline, baseline] }),
		});
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_run_config_request");
	});

	it("rejects a malformed body", async () => {
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	it("returns 404 naming the group that does not exist", async () => {
		const { baseline } = seedTwoConfigs();
		const res = await app.request("/v1/run-configs/compare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ config_hashes: [baseline, "f".repeat(64)] }),
		});
		expect(res.status).toBe(404);
		const body = await readJson(res, v.object({ error: v.string(), config_hash: v.string() }));
		expect(body.error).toBe("run_config_not_found");
		expect(body.config_hash).toBe("f".repeat(64));
	});
});

describe("GET /v1/run-configs/:hash", () => {
	it("returns the per-conversation breakdown with a replay to listen to", async () => {
		const { fast } = seedTwoConfigs();
		const res = await app.request(`/v1/run-configs/${fast}`);
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({
				hash: v.string(),
				replay_selection: v.string(),
				conversations: v.array(
					v.object({
						conversation_hash: v.string(),
						replay_id: v.string(),
						replays: v.array(v.object({ id: v.string() })),
					}),
				),
			}),
		);
		expect(body.hash).toBe(fast);
		expect(body.replay_selection).toBe("latest");
		expect(body.conversations).toHaveLength(2);
		expect(body.conversations[0]?.replay_id).toBe("fast-a");
	});

	it("accepts replay_selection=all", async () => {
		const { fast } = seedTwoConfigs();
		const res = await app.request(`/v1/run-configs/${fast}?replay_selection=all`);
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ replay_selection: v.string() }));
		expect(body.replay_selection).toBe("all");
	});

	it("rejects an unknown replay_selection", async () => {
		const { fast } = seedTwoConfigs();
		const res = await app.request(`/v1/run-configs/${fast}?replay_selection=sometimes`);
		expect(res.status).toBe(400);
	});

	it("rejects a hash that isn't a sha256", async () => {
		const res = await app.request("/v1/run-configs/not-a-hash");
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_run_config_hash");
	});

	it("returns 404 for a well-formed but unknown hash", async () => {
		const res = await app.request(`/v1/run-configs/${"e".repeat(64)}`);
		expect(res.status).toBe(404);
	});
});
