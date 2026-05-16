import { createApp } from "./server.ts";
import type { Store } from "./store/store.ts";
import { makeTempStore } from "./store/test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let store: Store;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	store = makeTempStore();
	app = createApp(store);
});

afterEach(() => {
	store.close();
});

describe("server composition", () => {
	it("exposes the healthz router at /healthz", async () => {
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("mounts the ingest router at /v1/sessions/:id/events", async () => {
		const res = await app.request("/v1/sessions/sess-1/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "session_started",
				agentId: "agent-x",
				startedAt: "2026-05-16T12:00:00.000Z",
			}),
		});
		expect(res.status).toBe(200);
	});

	it("returns 404 for unknown paths", async () => {
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
	});
});
