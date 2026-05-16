import * as v from "valibot";

import { createApp } from "@/server/server.ts";
import { saveSession } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeSession, makeTempStore } from "@/server/store/test-utils.ts";

import { makeCursor, makeListRequest } from "./sessions.test-utils.ts";
import { ListSessionsResponseSchema } from "./sessions.types.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const InvalidQueryBodySchema = v.object({
	error: v.literal("invalid_query"),
	issues: v.array(v.object({ kind: v.string(), type: v.string(), message: v.string() })),
});

let store: Store;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	store = makeTempStore();
	app = createApp(store);
});

afterEach(() => {
	store.close();
});

async function get(query: Record<string, string> = {}) {
	const res = await app.request(makeListRequest(query));
	return { res, body: v.parse(ListSessionsResponseSchema, await res.json()) };
}

describe("GET /v1/sessions — empty store", () => {
	it("returns an empty array with no nextCursor", async () => {
		const res = await app.request(makeListRequest());
		expect(res.status).toBe(200);
		const body = v.parse(ListSessionsResponseSchema, await res.json());
		expect(body).toEqual({ sessions: [], nextCursor: null });
	});
});

describe("GET /v1/sessions — happy path", () => {
	it("returns rows newest-first by startedAt", async () => {
		saveSession(store.db, makeSession({ id: "old", startedAt: "2026-05-15T10:00:00.000Z" }));
		saveSession(store.db, makeSession({ id: "mid", startedAt: "2026-05-15T12:00:00.000Z" }));
		saveSession(store.db, makeSession({ id: "new", startedAt: "2026-05-16T08:00:00.000Z" }));
		const { res, body } = await get();
		expect(res.status).toBe(200);
		expect(body.sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);
	});

	it("emits source=ingest for ingest-sourced rows and source=adapter:<provider> for adapter rows", async () => {
		saveSession(
			store.db,
			makeSession({ id: "i", source: "ingest", provider: null, agentId: "agent-i" }),
		);
		saveSession(
			store.db,
			makeSession({
				id: "a",
				source: "adapter",
				provider: "elevenlabs",
				agentId: "agent-a",
				startedAt: "2026-05-16T13:00:00.000Z",
			}),
		);
		const { body } = await get();
		const adapter = body.sessions.find((s) => s.id === "a");
		const ingest = body.sessions.find((s) => s.id === "i");
		expect(adapter?.source).toBe("adapter:elevenlabs");
		expect(ingest?.source).toBe("ingest");
	});

	it("filters by agentId", async () => {
		saveSession(store.db, makeSession({ id: "x", agentId: "agent-x" }));
		saveSession(store.db, makeSession({ id: "y", agentId: "agent-y" }));
		const { body } = await get({ agentId: "agent-y" });
		expect(body.sessions.map((s) => s.id)).toEqual(["y"]);
	});

	it("emits null endedAt and null durationMs for an in-progress session", async () => {
		saveSession(store.db, makeSession({ id: "live", endedAt: null, durationMs: null }));
		const { body } = await get();
		expect(body.sessions[0]?.endedAt).toBeNull();
		expect(body.sessions[0]?.durationMs).toBeNull();
	});
});

describe("GET /v1/sessions — pagination", () => {
	it("round-trips through pages using nextCursor", async () => {
		for (let i = 0; i < 5; i++) {
			saveSession(
				store.db,
				makeSession({ id: `s-${i}`, startedAt: `2026-05-16T12:0${i}:00.000Z` }),
			);
		}
		const first = await get({ limit: "2" });
		expect(first.body.sessions.map((s) => s.id)).toEqual(["s-4", "s-3"]);
		expect(first.body.nextCursor).not.toBeNull();
		if (first.body.nextCursor === null) return;

		const second = await get({ limit: "2", cursor: first.body.nextCursor });
		expect(second.body.sessions.map((s) => s.id)).toEqual(["s-2", "s-1"]);
		expect(second.body.nextCursor).not.toBeNull();
		if (second.body.nextCursor === null) return;

		const third = await get({ limit: "2", cursor: second.body.nextCursor });
		expect(third.body.sessions.map((s) => s.id)).toEqual(["s-0"]);
		// Short page → no more rows → nextCursor null.
		expect(third.body.nextCursor).toBeNull();
	});

	it("nextCursor is null on an exact-fit final page", async () => {
		// Exactly limit rows on the last page is the boundary that pagination loops
		// fail on if `nextCursor` is set whenever a row exists: an over-eager client
		// would fetch a fourth, empty page. We pay one possible empty page in the
		// even-rows case rather than need a count(*) check on every request.
		for (let i = 0; i < 4; i++) {
			saveSession(
				store.db,
				makeSession({ id: `s-${i}`, startedAt: `2026-05-16T12:0${i}:00.000Z` }),
			);
		}
		const first = await get({ limit: "2" });
		expect(first.body.sessions).toHaveLength(2);
		expect(first.body.nextCursor).not.toBeNull();
		if (first.body.nextCursor === null) return;

		const second = await get({ limit: "2", cursor: first.body.nextCursor });
		expect(second.body.sessions).toHaveLength(2);
		// Page filled exactly to limit; without more sessions a third page returns 0 rows.
		const third = await get({ limit: "2", cursor: second.body.nextCursor ?? "" });
		expect(third.body.sessions).toHaveLength(0);
		expect(third.body.nextCursor).toBeNull();
	});
});

describe("GET /v1/sessions — query validation", () => {
	it("returns 400 for a non-numeric limit", async () => {
		const res = await app.request(makeListRequest({ limit: "abc" }));
		expect(res.status).toBe(400);
		const body = v.parse(InvalidQueryBodySchema, await res.json());
		expect(body.error).toBe("invalid_query");
	});

	it("returns 400 for limit=0", async () => {
		const res = await app.request(makeListRequest({ limit: "0" }));
		expect(res.status).toBe(400);
	});

	it("returns 400 for a limit above the cap", async () => {
		const res = await app.request(makeListRequest({ limit: "10000" }));
		expect(res.status).toBe(400);
	});

	it("returns 400 for a malformed cursor (not base64url)", async () => {
		const res = await app.request(makeListRequest({ cursor: "!!!!not-base64!!!!" }));
		expect(res.status).toBe(400);
	});

	it("returns 400 for a cursor whose decoded JSON has the wrong shape", async () => {
		const bad = Buffer.from(JSON.stringify({ nope: 1 }), "utf8").toString("base64url");
		const res = await app.request(makeListRequest({ cursor: bad }));
		expect(res.status).toBe(400);
	});

	it("accepts a server-emitted cursor", async () => {
		const cursor = makeCursor({ startedAt: "2026-05-16T12:00:00.000Z", id: "s-1" });
		const res = await app.request(makeListRequest({ cursor }));
		expect(res.status).toBe(200);
	});

	it("strips input from echoed issues so a long agentId can't reflect back unbounded", async () => {
		const big = "x".repeat(2000);
		const res = await app.request(makeListRequest({ agentId: big }));
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(big);
	});
});
