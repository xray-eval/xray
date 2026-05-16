import { describe, expect, it } from "vitest";

import { handleRequest } from "./handler.ts";

describe("handleRequest", () => {
	it("returns 200 with {ok:true} JSON for /healthz", async () => {
		const res = handleRequest(new Request("http://x/healthz"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for unknown paths", () => {
		const res = handleRequest(new Request("http://x/nope"));
		expect(res.status).toBe(404);
	});
});
