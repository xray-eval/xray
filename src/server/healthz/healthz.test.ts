import { describe, expect, it } from "vitest";

import { healthz } from "./healthz.ts";

describe("healthz router", () => {
	it("returns 200 with {ok:true} for GET /", async () => {
		const res = await healthz.request("/");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
