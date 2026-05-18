import { Hono } from "hono";
import * as v from "valibot";

import { readJson } from "@/server/core/test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createConversationsRouter } from "./conversations.router.ts";
import { makeConversationSpec } from "./conversations.test-utils.ts";
import { describe, expect, it } from "bun:test";

function makeApp() {
	const store = makeTempStore();
	const app = new Hono().route("/v1", createConversationsRouter(store));
	return { app, store };
}

describe("POST /v1/conversations", () => {
	it("returns 200 and the upserted row on a valid body", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "alpha", version: "v1" })),
		});
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ id: v.string(), version: v.string() }));
		expect(body.id).toBe("alpha");
		expect(body.version).toBe("v1");
	});

	it("is idempotent — second call returns 200 same row", async () => {
		const { app } = makeApp();
		const spec = makeConversationSpec({ id: "alpha", version: "v1" });
		const a = await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(spec),
		});
		const b = await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(spec),
		});
		expect(b.status).toBe(200);
		expect(await a.json()).toEqual(await b.json());
	});

	it("returns 409 on (id, version) collision with drift", async () => {
		const { app } = makeApp();
		const spec = makeConversationSpec({ id: "alpha", version: "v1" });
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(spec),
		});
		const drifted = {
			...spec,
			turns: [
				{ role: "user", text: "totally different", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		};
		const res = await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(drifted),
		});
		expect(res.status).toBe(409);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("version_fingerprint_mismatch");
	});

	it("returns 400 on a body that fails validation", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "", version: "v1", turns: [] }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 on unparseable JSON", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/conversations", () => {
	it("returns aggregated rows", async () => {
		const { app } = makeApp();
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "a", version: "v1" })),
		});
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "a", version: "v2" })),
		});
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "b", version: "v1" })),
		});
		const res = await app.request("/v1/conversations");
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({ items: v.array(v.object({ id: v.string(), versions: v.number() })) }),
		);
		expect(body.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
		const a = body.items.find((i) => i.id === "a");
		expect(a?.versions).toBe(2);
	});
});

describe("GET /v1/conversations/:id", () => {
	it("returns latest version when no ?version", async () => {
		const { app } = makeApp();
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "x", version: "v1" })),
		});
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "x", version: "v2" })),
		});
		const res = await app.request("/v1/conversations/x");
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ version: v.string() }));
		expect(body.version).toBe("v2");
	});

	it("returns 404 for unknown id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations/missing");
		expect(res.status).toBe(404);
	});

	it("returns 404 for unknown ?version", async () => {
		const { app } = makeApp();
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "x", version: "v1" })),
		});
		const res = await app.request("/v1/conversations/x?version=missing");
		expect(res.status).toBe(404);
	});

	it("returns 400 for an invalid id", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations/..");
		// hono routes `..` separately; ensure non-200 either way
		expect(res.status === 400 || res.status === 404).toBe(true);
	});
});

describe("GET /v1/conversations/:id/replays", () => {
	it("returns empty items for a known conversation with no replays", async () => {
		const { app } = makeApp();
		await app.request("/v1/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(makeConversationSpec({ id: "x", version: "v1" })),
		});
		const res = await app.request("/v1/conversations/x/replays");
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ items: v.array(v.unknown()) }));
		expect(body.items).toEqual([]);
	});

	it("returns 404 for unknown conversation", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations/missing/replays");
		expect(res.status).toBe(404);
	});
});
