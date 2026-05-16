import { describe, expect, it } from "vitest";

import { app } from "./server.ts";

describe("server composition", () => {
	it("exposes the healthz router at /healthz", async () => {
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for unknown paths", async () => {
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
	});
});
