import { HttpResponse, http } from "msw";
import * as v from "valibot";

import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { applyEvent } from "@/server/ingest/ingest.service.ts";
import {
	makeSessionStartedEvent,
	makeTurnCompletedEvent,
} from "@/server/ingest/ingest.test-utils.ts";
import { createApp } from "@/server/server.ts";
import { getReplayRun } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { server } from "@/test-server.ts";

import {
	makeCreateReplayRequest,
	makeCreateReplayRequestObject,
	makeGetReplayRequest,
	makeListSessionReplaysRequest,
} from "./replays.test-utils.ts";
import { ListReplayRunsResponseSchema, ReplayRunResponseSchema } from "./replays.types.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const ErrorBodySchema = v.object({
	error: v.string(),
	sessionId: v.optional(v.string()),
	replayId: v.optional(v.string()),
});

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
	app = createApp(store, { audioRoot: audio.path });
});

afterEach(() => {
	store.close();
	audio.dispose();
});

function seedSource(sessionId: string) {
	applyEvent(store, sessionId, makeSessionStartedEvent({ agentId: "src" }));
	applyEvent(store, sessionId, makeTurnCompletedEvent({ idx: 0, role: "user", text: "hi" }));
	applyEvent(store, sessionId, makeTurnCompletedEvent({ idx: 1, role: "agent", text: "hello" }));
}

/** Wait until `predicate` returns a value or the loop hits N tries; tests
 * are driving an async fire-and-forget worker through real HTTP mocks. */
async function eventually<T>(predicate: () => T | undefined, tries = 20): Promise<T> {
	for (let i = 0; i < tries; i++) {
		const result = predicate();
		if (result !== undefined) return result;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("eventually: predicate never returned a value");
}

describe("POST /v1/replays — happy path", () => {
	it("returns 202 with the run id and a pending status", async () => {
		seedSource("src-1");
		server.use(
			http.post("https://example.test/webhook", () => HttpResponse.json({ agentText: "ok" })),
		);
		const res = await app.request(
			makeCreateReplayRequestObject(makeCreateReplayRequest({ sourceSessionId: "src-1" })),
		);
		expect(res.status).toBe(202);
		const body = v.parse(ReplayRunResponseSchema, await res.json());
		expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.sourceSessionId).toBe("src-1");
		expect(["pending", "running", "completed"]).toContain(body.status);
	});

	it("runs the worker fire-and-forget; GET reflects completion eventually", async () => {
		seedSource("src-1");
		server.use(
			http.post("https://example.test/webhook", () => HttpResponse.json({ agentText: "ok" })),
		);
		const createRes = await app.request(
			makeCreateReplayRequestObject(makeCreateReplayRequest({ sourceSessionId: "src-1" })),
		);
		const created = v.parse(ReplayRunResponseSchema, await createRes.json());

		const completed = await eventually(() => {
			const row = getReplayRun(store.db, created.id);
			return row?.status === "completed" ? row : undefined;
		});
		expect(completed.progressCompleted).toBe(1);
	});
});

describe("POST /v1/replays — validation", () => {
	it("returns 400 when the body is not valid JSON", async () => {
		const res = await app.request(
			new Request("http://test.local/v1/replays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json",
			}),
		);
		expect(res.status).toBe(400);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("invalid_replay_request");
	});

	it("returns 400 when webhookUrl is not a URL", async () => {
		seedSource("src-1");
		const res = await app.request(
			makeCreateReplayRequestObject({
				sourceSessionId: "src-1",
				webhookUrl: "not a url",
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects non-http(s) webhook URL schemes (file://, gopher://, etc.)", async () => {
		seedSource("src-1");
		const cases = [
			"file:///etc/passwd",
			"gopher://example.test/",
			"javascript:alert(1)",
			"data:text/plain,hello",
		];
		for (const webhookUrl of cases) {
			const res = await app.request(
				makeCreateReplayRequestObject({ sourceSessionId: "src-1", webhookUrl }),
			);
			expect(res.status).toBe(400);
		}
	});

	it("returns 404 when source session doesn't exist", async () => {
		const res = await app.request(
			makeCreateReplayRequestObject(makeCreateReplayRequest({ sourceSessionId: "missing" })),
		);
		expect(res.status).toBe(404);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("source_session_not_found");
		expect(body.sessionId).toBe("missing");
	});

	it("strips caller input from echoed issues so a long webhookUrl can't reflect back unbounded", async () => {
		seedSource("src-1");
		const big = `https://example.test/${"x".repeat(3000)}`;
		const res = await app.request(
			makeCreateReplayRequestObject({
				sourceSessionId: "src-1",
				webhookUrl: big,
			}),
		);
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(big);
	});
});

describe("GET /v1/sessions/:sessionId/replays", () => {
	it("returns 404 when the session doesn't exist", async () => {
		const res = await app.request(makeListSessionReplaysRequest("missing"));
		expect(res.status).toBe(404);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("session_not_found");
		expect(body.sessionId).toBe("missing");
	});

	it("returns 400 when the session id violates the schema", async () => {
		const res = await app.request(
			new Request("http://test.local/v1/sessions/bad..id/replays", { method: "GET" }),
		);
		expect(res.status).toBe(400);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("invalid_session_id");
	});

	it("returns 200 with an empty items array when no replays exist", async () => {
		seedSource("src-1");
		const res = await app.request(makeListSessionReplaysRequest("src-1"));
		expect(res.status).toBe(200);
		const body = v.parse(ListReplayRunsResponseSchema, await res.json());
		expect(body.items).toEqual([]);
	});

	it("lists replays for the session newest-first", async () => {
		seedSource("src-1");
		server.use(
			http.post("https://example.test/webhook", () => HttpResponse.json({ agentText: "ok" })),
		);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const createRes = await app.request(
				makeCreateReplayRequestObject(makeCreateReplayRequest({ sourceSessionId: "src-1" })),
			);
			const created = v.parse(ReplayRunResponseSchema, await createRes.json());
			ids.push(created.id);
		}

		const res = await app.request(makeListSessionReplaysRequest("src-1"));
		expect(res.status).toBe(200);
		const body = v.parse(ListReplayRunsResponseSchema, await res.json());
		expect(body.items).toHaveLength(3);
		expect(new Set(body.items.map((r) => r.id))).toEqual(new Set(ids));
		// Pairwise check: each row's startedAt must be >= the next row's. Asserts
		// the order contract without depending on a JS sort over potentially-tied
		// timestamps.
		for (let i = 0; i < body.items.length - 1; i++) {
			const current = body.items[i];
			const next = body.items[i + 1];
			if (current === undefined || next === undefined) continue;
			expect(current.startedAt >= next.startedAt).toBe(true);
		}
	});

	it("does not include replays whose source is a different session", async () => {
		seedSource("src-1");
		seedSource("src-2");
		server.use(
			http.post("https://example.test/webhook", () => HttpResponse.json({ agentText: "ok" })),
		);
		const createRes = await app.request(
			makeCreateReplayRequestObject(makeCreateReplayRequest({ sourceSessionId: "src-2" })),
		);
		expect(createRes.status).toBe(202);

		const res = await app.request(makeListSessionReplaysRequest("src-1"));
		expect(res.status).toBe(200);
		const body = v.parse(ListReplayRunsResponseSchema, await res.json());
		expect(body.items).toEqual([]);
	});
});

describe("GET /v1/replays/:id", () => {
	it("returns 404 with a typed body for an unknown id", async () => {
		const res = await app.request(makeGetReplayRequest("00000000-0000-0000-0000-000000000000"));
		expect(res.status).toBe(404);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("replay_not_found");
	});

	it("returns 400 for a malformed id", async () => {
		const res = await app.request(makeGetReplayRequest("not-a-uuid"));
		expect(res.status).toBe(400);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("invalid_replay_id");
	});

	it("returns the current run state after creation", async () => {
		seedSource("src-1");
		server.use(
			http.post("https://example.test/webhook", () => HttpResponse.json({ agentText: "ok" })),
		);
		const createRes = await app.request(
			makeCreateReplayRequestObject(makeCreateReplayRequest({ sourceSessionId: "src-1" })),
		);
		const created = v.parse(ReplayRunResponseSchema, await createRes.json());

		// Poll until we get a stable terminal state (completed) — eliminates
		// flakiness from racing the fire-and-forget worker.
		await eventually(() => {
			const row = getReplayRun(store.db, created.id);
			return row?.status === "completed" || row?.status === "failed" ? row : undefined;
		});

		const res = await app.request(makeGetReplayRequest(created.id));
		expect(res.status).toBe(200);
		const body = v.parse(ReplayRunResponseSchema, await res.json());
		expect(body.id).toBe(created.id);
		expect(body.status).toBe("completed");
	});
});
