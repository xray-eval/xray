import * as v from "valibot";

import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { createApp } from "@/server/server.ts";
import { getSession, listSessions } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { listToolCallsForTurn } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";

import {
	makeEventRequest,
	makeSessionEndedEvent,
	makeSessionStartedEvent,
	makeToolCalledEvent,
	makeTurnCompletedEvent,
} from "./ingest.test-utils.ts";
import { SessionIdSchema } from "./ingest.types.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const IssueSchema = v.object({
	kind: v.string(),
	type: v.string(),
	message: v.string(),
});
const InvalidEventBodySchema = v.object({
	error: v.literal("invalid_event"),
	issues: v.array(IssueSchema),
});
const ErrorBodySchema = v.object({ error: v.string() });
const UnknownTurnBodySchema = v.object({
	error: v.literal("unknown_turn"),
	sessionId: v.string(),
	turnIdx: v.number(),
});
const BodyTooLargeBodySchema = v.object({
	error: v.literal("body_too_large"),
	maxBytes: v.number(),
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

async function post(sessionId: string, event: unknown): Promise<Response> {
	return app.request(makeEventRequest(sessionId, event));
}

describe("POST /v1/sessions/:id/events — happy path", () => {
	it("accepts a session_started and creates the session row", async () => {
		const res = await post(
			"sess-A",
			makeSessionStartedEvent({ agentId: "agent-1", startedAt: "2026-05-16T12:00:00.000Z" }),
		);
		expect(res.status).toBe(200);
		const row = getSession(store.db, "sess-A");
		expect(row).toMatchObject({
			id: "sess-A",
			source: "ingest",
			provider: null,
			agentId: "agent-1",
			startedAt: "2026-05-16T12:00:00.000Z",
		});
	});

	it("accepts a turn_completed and creates the turn row", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const res = await post(
			"sess-A",
			makeTurnCompletedEvent({
				idx: 0,
				role: "user",
				text: "hi",
				timestamp: "2026-05-16T12:00:01.000Z",
				responseLatencyMs: 1234,
			}),
		);
		expect(res.status).toBe(200);
		const rows = listTurnsForSession(store.db, "sess-A");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			sessionId: "sess-A",
			idx: 0,
			role: "user",
			text: "hi",
			ts: "2026-05-16T12:00:01.000Z",
			responseLatencyMs: 1234,
		});
	});

	it("accepts a turn_completed with barge-in fields", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const res = await post(
			"sess-A",
			makeTurnCompletedEvent({
				idx: 0,
				role: "agent",
				text: "Sure, I can…",
				responseLatencyMs: 400,
				interrupted: true,
				interruptedAtMs: 800,
			}),
		);
		expect(res.status).toBe(200);
		const [row] = listTurnsForSession(store.db, "sess-A");
		expect(row).toMatchObject({
			responseLatencyMs: 400,
			interrupted: true,
			interruptedAtMs: 800,
		});
	});

	// Pins the loose contract: `interrupted` and `interruptedAtMs` are independent
	// optionals. The schema accepts mismatched combinations (false + offset, true
	// without offset). Promote to a `v.check` cross-field guard if that becomes wrong.
	it("accepts a turn_completed with interrupted=false but a stored interruptedAtMs", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const res = await post(
			"sess-A",
			makeTurnCompletedEvent({
				idx: 0,
				role: "agent",
				text: "ok",
				interrupted: false,
				interruptedAtMs: 800,
			}),
		);
		expect(res.status).toBe(200);
		const [row] = listTurnsForSession(store.db, "sess-A");
		expect(row).toMatchObject({ interrupted: false, interruptedAtMs: 800 });
	});

	it("accepts a turn_completed with interrupted=true without interruptedAtMs", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const res = await post(
			"sess-A",
			makeTurnCompletedEvent({
				idx: 0,
				role: "agent",
				text: "ok",
				interrupted: true,
			}),
		);
		expect(res.status).toBe(200);
		const [row] = listTurnsForSession(store.db, "sess-A");
		expect(row).toMatchObject({ interrupted: true, interruptedAtMs: null });
	});

	it("accepts a tool_called and creates the tool-call row under its turn", async () => {
		await post("sess-A", makeSessionStartedEvent());
		await post("sess-A", makeTurnCompletedEvent({ idx: 0, role: "agent" }));
		const res = await post(
			"sess-A",
			makeToolCalledEvent({
				turnIdx: 0,
				name: "lookup",
				args: { q: "weather" },
				result: { ok: true },
				latencyMs: 42,
			}),
		);
		expect(res.status).toBe(200);
		const [turn] = listTurnsForSession(store.db, "sess-A");
		expect(turn).toBeDefined();
		if (!turn) return;
		const calls = listToolCallsForTurn(store.db, turn.id);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			name: "lookup",
			argsJson: JSON.stringify({ q: "weather" }),
			resultJson: JSON.stringify({ ok: true }),
			latencyMs: 42,
		});
	});

	it("accepts a session_ended and stamps endedAt/durationMs", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const res = await post(
			"sess-A",
			makeSessionEndedEvent({ endedAt: "2026-05-16T12:05:00.000Z", durationMs: 300_000 }),
		);
		expect(res.status).toBe(200);
		const row = getSession(store.db, "sess-A");
		expect(row?.endedAt).toBe("2026-05-16T12:05:00.000Z");
		expect(row?.durationMs).toBe(300_000);
	});
});

describe("POST /v1/sessions/:id/events — schema rejection", () => {
	it("returns 400 with issues[] for a missing required field", async () => {
		const res = await post("sess-A", { type: "turn_completed" });
		expect(res.status).toBe(400);
		const body = v.parse(InvalidEventBodySchema, await res.json());
		expect(body.error).toBe("invalid_event");
		expect(body.issues.length).toBeGreaterThan(0);
	});

	it("returns 400 for an unknown event type", async () => {
		const res = await post("sess-A", { type: "nope" });
		expect(res.status).toBe(400);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("invalid_event");
	});

	it("returns 400 for a wrong field type", async () => {
		const badBody: unknown = {
			type: "turn_completed",
			idx: 0,
			role: "user",
			text: "hi",
			timestamp: 123,
		};
		const res = await post("sess-A", badBody);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a negative interruptedAtMs", async () => {
		const res = await post("sess-A", {
			type: "turn_completed",
			idx: 0,
			role: "agent",
			text: "x",
			timestamp: "2026-05-16T12:00:01.000Z",
			interrupted: true,
			interruptedAtMs: -1,
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for a non-ISO 8601 timestamp", async () => {
		const badBody: unknown = {
			type: "session_started",
			agentId: "agent-1",
			startedAt: "tomorrow at noon",
		};
		const res = await post("sess-A", badBody);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a non-JSON body with the same shape as a schema failure", async () => {
		const req = new Request("http://test.local/v1/sessions/sess-A/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		const res = await app.request(req);
		expect(res.status).toBe(400);
		// Same response shape both 400 paths must use — JSON-parse failure and
		// Valibot schema failure both emit { error: "invalid_event", issues: [...] }
		// where every issue carries the BaseIssue-shaped fields below.
		const body = v.parse(InvalidEventBodySchema, await res.json());
		expect(body.issues).toHaveLength(1);
	});

	it("strips `input` from echoed issues so a megabyte body can't reflect back unbounded", async () => {
		const big = "x".repeat(10_000);
		const res = await post("sess-A", {
			type: "turn_completed",
			idx: 0,
			role: "user",
			text: big,
			timestamp: "tomorrow at noon", // forces a schema failure, but `input` would otherwise echo `big`
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(big);
	});

	it("returns 400 for a session id with disallowed characters", async () => {
		const req = new Request("http://test.local/v1/sessions/has%20space/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(makeSessionStartedEvent()),
		});
		const res = await app.request(req);
		expect(res.status).toBe(400);
	});
});

describe("SessionIdSchema — path-traversal defense", () => {
	it.each([".", "..", "a..b", "..a", "a..", "../etc/passwd", "./foo"])("rejects %p", (badId) => {
		const result = v.safeParse(SessionIdSchema, badId);
		expect(result.success).toBe(false);
	});

	it("accepts ids with a single dot (e.g. version-like)", () => {
		const result = v.safeParse(SessionIdSchema, "sess.v1");
		expect(result.success).toBe(true);
	});
});

describe("POST /v1/sessions/:id/events — body size cap", () => {
	it("returns 413 body_too_large when content-length exceeds the cap", async () => {
		const req = new Request("http://test.local/v1/sessions/sess-A/events", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024) },
			body: "x".repeat(2 * 1024 * 1024),
		});
		const res = await app.request(req);
		expect(res.status).toBe(413);
		const body = v.parse(BodyTooLargeBodySchema, await res.json());
		expect(body.maxBytes).toBeGreaterThan(0);
	});
});

describe("POST /v1/sessions/:id/events — timezone normalization", () => {
	it("normalizes a non-UTC ISO timestamp to UTC `Z` before persisting", async () => {
		// 12:00 in +09:00 == 03:00 UTC; after normalization the row must read 03:00 Z,
		// otherwise SQLite's TEXT comparison would lex-sort the row against UTC rows
		// incorrectly (the MIN-merge invariant in sessions-repo depends on this).
		await post("sess-A", {
			type: "session_started",
			agentId: "agent-1",
			startedAt: "2026-05-16T12:00:00+09:00",
		});
		const row = getSession(store.db, "sess-A");
		expect(row?.startedAt).toBe("2026-05-16T03:00:00.000Z");
	});
});

describe("POST /v1/sessions/:id/events — idempotency", () => {
	it("re-POSTing the same turn_completed is a no-op (no duplicate row)", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const evt = makeTurnCompletedEvent({ idx: 0, role: "user", text: "hi" });
		const r1 = await post("sess-A", evt);
		const r2 = await post("sess-A", evt);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(listTurnsForSession(store.db, "sess-A")).toHaveLength(1);
	});

	it("re-POSTing the same tool_called is a no-op (no duplicate row)", async () => {
		await post("sess-A", makeSessionStartedEvent());
		await post("sess-A", makeTurnCompletedEvent({ idx: 0, role: "agent" }));
		const evt = makeToolCalledEvent({ turnIdx: 0, idx: 0, name: "lookup" });
		const r1 = await post("sess-A", evt);
		const r2 = await post("sess-A", evt);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		const [turn] = listTurnsForSession(store.db, "sess-A");
		expect(turn).toBeDefined();
		if (!turn) return;
		expect(listToolCallsForTurn(store.db, turn.id)).toHaveLength(1);
	});
});

describe("POST /v1/sessions/:id/events — auto-create", () => {
	it("auto-creates a stub session when the first event is turn_completed", async () => {
		const res = await post(
			"sess-A",
			makeTurnCompletedEvent({ idx: 0, timestamp: "2026-05-16T12:00:01.000Z" }),
		);
		expect(res.status).toBe(200);
		const row = getSession(store.db, "sess-A");
		expect(row).toMatchObject({
			id: "sess-A",
			source: "ingest",
			agentId: "unknown",
			startedAt: "2026-05-16T12:00:01.000Z",
		});
	});

	it("later session_started upserts metadata onto the stub", async () => {
		await post("sess-A", makeTurnCompletedEvent({ idx: 0, timestamp: "2026-05-16T12:00:01.000Z" }));
		await post(
			"sess-A",
			makeSessionStartedEvent({ agentId: "agent-real", startedAt: "2026-05-16T12:00:00.000Z" }),
		);
		const row = getSession(store.db, "sess-A");
		expect(row?.agentId).toBe("agent-real");
		expect(row?.startedAt).toBe("2026-05-16T12:00:00.000Z");
		// Auto-create + later session_started should still produce one session row.
		expect(listSessions(store.db)).toHaveLength(1);
	});
});

describe("POST /v1/sessions/:id/events — bulk replay", () => {
	it("ingests 1000 turn_completed events with ordering preserved", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const N = 1000;
		for (let i = 0; i < N; i++) {
			const res = await post(
				"sess-A",
				makeTurnCompletedEvent({
					idx: i,
					role: i % 2 === 0 ? "user" : "agent",
					text: `turn-${i}`,
					timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
				}),
			);
			expect(res.status).toBe(200);
		}
		const rows = listTurnsForSession(store.db, "sess-A");
		expect(rows).toHaveLength(N);
		expect(rows[0]?.idx).toBe(0);
		expect(rows[N - 1]?.idx).toBe(N - 1);
		expect(rows[N - 1]?.text).toBe(`turn-${N - 1}`);
	}, 30_000);
});

describe("POST /v1/sessions/:id/events — tool_called for missing turn", () => {
	it("returns 422 with an unknown_turn error", async () => {
		await post("sess-A", makeSessionStartedEvent());
		const res = await post("sess-A", makeToolCalledEvent({ turnIdx: 99 }));
		expect(res.status).toBe(422);
		const body = v.parse(UnknownTurnBodySchema, await res.json());
		expect(body.error).toBe("unknown_turn");
		expect(body.turnIdx).toBe(99);
	});
});
