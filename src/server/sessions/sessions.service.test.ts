import { saveSession } from "@/server/store/sessions-repo.ts";
import {
	makeSession,
	makeTempStore,
	makeToolCallInput,
	makeTurnInput,
} from "@/server/store/test-utils.ts";
import { appendToolCalls } from "@/server/store/tool-calls-repo.ts";
import { appendTurns } from "@/server/store/turns-repo.ts";

import { tryDecodeCursor } from "./cursor/cursor.ts";
import {
	CorruptToolCallJsonError,
	InconsistentSessionRowError,
	SessionNotFoundError,
} from "./sessions.errors.ts";
import { getConversationForApi, listSessionsForApi } from "./sessions.service.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let store: ReturnType<typeof makeTempStore>;

beforeEach(() => {
	store = makeTempStore();
});

afterEach(() => {
	store.close();
});

describe("listSessionsForApi — source mapping", () => {
	it("emits `ingest` for ingest-sourced rows", () => {
		saveSession(store.db, makeSession({ id: "i", source: "ingest", provider: null }));
		const { sessions } = listSessionsForApi(store, { limit: 10 });
		expect(sessions[0]?.source).toBe("ingest");
	});

	it("emits `adapter:<provider>` for adapter-sourced rows", () => {
		saveSession(store.db, makeSession({ id: "a", source: "adapter", provider: "elevenlabs" }));
		const { sessions } = listSessionsForApi(store, { limit: 10 });
		expect(sessions[0]?.source).toBe("adapter:elevenlabs");
	});

	it("throws InconsistentSessionRowError when source='adapter' but provider is null", () => {
		// The state can't normally be reached via the writers; we construct it
		// directly to prove the read path fails loudly rather than silently
		// mislabeling the row as `ingest` (per errors.md §1 — message must not
		// be load-bearing).
		saveSession(store.db, makeSession({ id: "bad", source: "adapter", provider: null }));
		expect(() => listSessionsForApi(store, { limit: 10 })).toThrow(InconsistentSessionRowError);
	});
});

describe("listSessionsForApi — pagination", () => {
	it("returns rows newest-first within the limit", () => {
		for (let i = 0; i < 3; i++) {
			saveSession(
				store.db,
				makeSession({ id: `s-${i}`, startedAt: `2026-05-16T12:0${i}:00.000Z` }),
			);
		}
		const { sessions } = listSessionsForApi(store, { limit: 10 });
		expect(sessions.map((s) => s.id)).toEqual(["s-2", "s-1", "s-0"]);
	});

	it("returns nextCursor=null when fewer rows than the limit are returned", () => {
		saveSession(store.db, makeSession({ id: "only" }));
		const { nextCursor } = listSessionsForApi(store, { limit: 10 });
		expect(nextCursor).toBeNull();
	});

	it("returns a non-null nextCursor when the page fills exactly to limit", () => {
		// The "filled-page heuristic": rows.length === limit ⇒ emit a cursor.
		// Pays one possible empty page in the exact-fit final case in exchange
		// for never running count(*).
		for (let i = 0; i < 3; i++) {
			saveSession(
				store.db,
				makeSession({ id: `s-${i}`, startedAt: `2026-05-16T12:0${i}:00.000Z` }),
			);
		}
		const { nextCursor } = listSessionsForApi(store, { limit: 3 });
		expect(nextCursor).not.toBeNull();
		if (nextCursor === null) return;
		// The cursor points at the last row of the page.
		expect(tryDecodeCursor(nextCursor)).toEqual({
			startedAt: "2026-05-16T12:00:00.000Z",
			id: "s-0",
		});
	});

	it("uses the cursor to fetch the next page", () => {
		for (let i = 0; i < 5; i++) {
			saveSession(
				store.db,
				makeSession({ id: `s-${i}`, startedAt: `2026-05-16T12:0${i}:00.000Z` }),
			);
		}
		// `listSessionsForApi` receives an already-decoded cursor — the router
		// runs `ListSessionsQuerySchema`'s rawTransform before this point.
		const cursor = { startedAt: "2026-05-16T12:03:00.000Z", id: "s-3" };
		const { sessions, nextCursor } = listSessionsForApi(store, { limit: 10, cursor });
		expect(sessions.map((s) => s.id)).toEqual(["s-2", "s-1", "s-0"]);
		expect(nextCursor).toBeNull();
	});
});

describe("listSessionsForApi — agentId filter", () => {
	it("returns only sessions matching agentId", () => {
		saveSession(store.db, makeSession({ id: "x", agentId: "agent-x" }));
		saveSession(store.db, makeSession({ id: "y", agentId: "agent-y" }));
		const { sessions } = listSessionsForApi(store, { limit: 10, agentId: "agent-y" });
		expect(sessions.map((s) => s.id)).toEqual(["y"]);
	});
});

describe("getConversationForApi — happy path", () => {
	it("returns metadata + ordered turns + grouped tool calls", () => {
		saveSession(
			store.db,
			makeSession({
				id: "sess-1",
				agentId: "agent-x",
				startedAt: "2026-05-16T12:00:00.000Z",
				endedAt: "2026-05-16T12:05:00.000Z",
				durationMs: 300_000,
			}),
		);
		appendTurns(store.db, "sess-1", [
			makeTurnInput({
				id: "t-1",
				idx: 1,
				role: "agent",
				text: "second",
				ts: "2026-05-16T12:00:02.000Z",
				responseLatencyMs: 800,
			}),
			makeTurnInput({
				id: "t-0",
				idx: 0,
				role: "user",
				text: "first",
				ts: "2026-05-16T12:00:01.000Z",
			}),
		]);
		appendToolCalls(store.db, "t-1", [
			makeToolCallInput({ idx: 0, name: "lookup", argsJson: '{"q":"hi"}' }),
			makeToolCallInput({ idx: 1, name: "store", argsJson: "{}", resultJson: '{"ok":true}' }),
		]);

		const conv = getConversationForApi(store, "sess-1");
		expect(conv).toMatchObject({
			id: "sess-1",
			agentId: "agent-x",
			startedAt: "2026-05-16T12:00:00.000Z",
			endedAt: "2026-05-16T12:05:00.000Z",
			durationMs: 300_000,
			source: "ingest",
		});
		expect(conv.turns.map((t) => t.id)).toEqual(["t-0", "t-1"]);
		expect(conv.turns[0]?.toolCalls).toEqual([]);
		expect(conv.turns[1]?.toolCalls.map((c) => c.name)).toEqual(["lookup", "store"]);
		expect(conv.turns[1]?.toolCalls[0]?.args).toEqual({ q: "hi" });
		expect(conv.turns[1]?.toolCalls[1]?.result).toEqual({ ok: true });
		expect(conv.turns[1]?.toolCalls[0]?.result).toBeNull();
	});

	it("emits the barge-in fields when set", () => {
		saveSession(store.db, makeSession({ id: "sess-1" }));
		appendTurns(store.db, "sess-1", [
			makeTurnInput({
				id: "t-0",
				idx: 0,
				role: "agent",
				interrupted: true,
				interruptedAtMs: 800,
				responseLatencyMs: 1234,
			}),
		]);
		const { turns } = getConversationForApi(store, "sess-1");
		expect(turns[0]).toMatchObject({
			interrupted: true,
			interruptedAtMs: 800,
			responseLatencyMs: 1234,
		});
	});

	it("emits null barge-in fields when not set", () => {
		saveSession(store.db, makeSession({ id: "sess-1" }));
		appendTurns(store.db, "sess-1", [makeTurnInput({ id: "t-0", idx: 0 })]);
		const { turns } = getConversationForApi(store, "sess-1");
		expect(turns[0]?.interrupted).toBeNull();
		expect(turns[0]?.interruptedAtMs).toBeNull();
		expect(turns[0]?.responseLatencyMs).toBeNull();
	});

	it("composes `adapter:<provider>` for adapter-sourced sessions", () => {
		saveSession(store.db, makeSession({ id: "sess-A", source: "adapter", provider: "elevenlabs" }));
		expect(getConversationForApi(store, "sess-A").source).toBe("adapter:elevenlabs");
	});
});

describe("getConversationForApi — error paths", () => {
	it("throws SessionNotFoundError when no row matches", () => {
		expect(() => getConversationForApi(store, "missing")).toThrow(SessionNotFoundError);
	});

	it("throws InconsistentSessionRowError when source='adapter' but provider is null", () => {
		// Same as the list path — read must fail loudly rather than mislabel.
		saveSession(store.db, makeSession({ id: "bad", source: "adapter", provider: null }));
		expect(() => getConversationForApi(store, "bad")).toThrow(InconsistentSessionRowError);
	});

	it("throws CorruptToolCallJsonError when args_json is unparseable", () => {
		// The state cannot be produced by `applyEvent` (which always uses
		// `JSON.stringify`), so we write directly through the repo with a raw
		// invalid string to prove the read fails loudly.
		saveSession(store.db, makeSession({ id: "sess-1" }));
		appendTurns(store.db, "sess-1", [makeTurnInput({ id: "t-0", idx: 0 })]);
		appendToolCalls(store.db, "t-0", [makeToolCallInput({ idx: 0, argsJson: "not json {" })]);
		expect(() => getConversationForApi(store, "sess-1")).toThrow(CorruptToolCallJsonError);
	});
});
