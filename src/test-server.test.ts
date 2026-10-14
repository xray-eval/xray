import { afterAll, beforeAll, expect, test } from "bun:test";

// The guarantee `bun-test-setup.ts` exists to give: a request no test mocked
// never reaches the network. A real listener stands in for "the network" so a
// silent pass-through (MSW's default "warn" strategy) shows up as a 200
// instead of hiding behind a DNS failure.
let realServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	realServer = Bun.serve({ port: 0, fetch: () => new Response("reached the network") });
});

afterAll(() => {
	void realServer.stop(true);
});

test("an unmocked request fails instead of passing through to the network", async () => {
	await expect(fetch(`http://127.0.0.1:${realServer.port}/`)).rejects.toThrow();
});
