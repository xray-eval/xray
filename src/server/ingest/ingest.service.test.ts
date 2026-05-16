import { getSession, listSessions } from "@/server/store/sessions-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { listToolCallsForTurn } from "@/server/store/tool-calls-repo.ts";
import { listTurnsForSession } from "@/server/store/turns-repo.ts";

import { UnknownTurnError } from "./ingest.errors.ts";
import { applyEvent } from "./ingest.service.ts";
import {
	makeSessionEndedEvent,
	makeSessionStartedEvent,
	makeToolCalledEvent,
	makeTurnCompletedEvent,
} from "./ingest.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let store: Store;
beforeEach(() => {
	store = makeTempStore();
});
afterEach(() => {
	store.close();
});

describe("applyEvent — session_started", () => {
	it("upserts a session row from the validated event", () => {
		applyEvent(
			store,
			"s-1",
			makeSessionStartedEvent({ agentId: "agent-x", startedAt: "2026-05-16T12:00:00.000Z" }),
		);
		expect(getSession(store.db, "s-1")).toMatchObject({
			id: "s-1",
			source: "ingest",
			provider: null,
			agentId: "agent-x",
			startedAt: "2026-05-16T12:00:00.000Z",
		});
	});
});

describe("applyEvent — turn_completed", () => {
	it("creates a stub session and appends the turn", () => {
		applyEvent(store, "s-1", makeTurnCompletedEvent());
		expect(getSession(store.db, "s-1")?.agentId).toBe("unknown");
		expect(listTurnsForSession(store.db, "s-1")).toHaveLength(1);
	});

	it("is idempotent on (sessionId, idx)", () => {
		const evt = makeTurnCompletedEvent();
		applyEvent(store, "s-1", evt);
		applyEvent(store, "s-1", evt);
		expect(listTurnsForSession(store.db, "s-1")).toHaveLength(1);
	});
});

describe("applyEvent — tool_called", () => {
	it("throws UnknownTurnError when the turn doesn't exist", () => {
		applyEvent(store, "s-1", makeSessionStartedEvent());
		expect(() => applyEvent(store, "s-1", makeToolCalledEvent({ turnIdx: 7 }))).toThrow(
			UnknownTurnError,
		);
	});

	it("appends a tool call row under the matching turn", () => {
		applyEvent(store, "s-1", makeTurnCompletedEvent({ role: "agent", text: "ok" }));
		applyEvent(
			store,
			"s-1",
			makeToolCalledEvent({ args: { q: "x" }, result: { ok: true }, latencyMs: 42 }),
		);
		const [turn] = listTurnsForSession(store.db, "s-1");
		if (!turn) throw new Error("turn missing");
		const calls = listToolCallsForTurn(store.db, turn.id);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			name: "lookup",
			argsJson: JSON.stringify({ q: "x" }),
			resultJson: JSON.stringify({ ok: true }),
			latencyMs: 42,
		});
	});

	it("stores null result_json when result is omitted", () => {
		applyEvent(store, "s-1", makeTurnCompletedEvent({ role: "agent", text: "ok" }));
		applyEvent(store, "s-1", makeToolCalledEvent({ args: { q: "x" } }));
		const [turn] = listTurnsForSession(store.db, "s-1");
		if (!turn) throw new Error("turn missing");
		const [call] = listToolCallsForTurn(store.db, turn.id);
		expect(call?.resultJson).toBeNull();
	});
});

describe("applyEvent — session_ended", () => {
	it("stamps endedAt and durationMs on an existing session", () => {
		applyEvent(store, "s-1", makeSessionStartedEvent());
		applyEvent(
			store,
			"s-1",
			makeSessionEndedEvent({ endedAt: "2026-05-16T12:05:00.000Z", durationMs: 300_000 }),
		);
		const row = getSession(store.db, "s-1");
		expect(row?.endedAt).toBe("2026-05-16T12:05:00.000Z");
		expect(row?.durationMs).toBe(300_000);
	});

	it("auto-creates a stub when no prior event exists", () => {
		applyEvent(
			store,
			"s-1",
			makeSessionEndedEvent({ endedAt: "2026-05-16T12:05:00.000Z", durationMs: 300_000 }),
		);
		expect(listSessions(store.db)).toHaveLength(1);
		const row = getSession(store.db, "s-1");
		expect(row?.endedAt).toBe("2026-05-16T12:05:00.000Z");
	});
});
