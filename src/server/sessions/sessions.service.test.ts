import { saveSession } from "@/server/store/sessions-repo.ts";
import { makeSession, makeTempStore } from "@/server/store/test-utils.ts";

import { tryDecodeCursor } from "./cursor/cursor.ts";
import { InconsistentSessionRowError } from "./sessions.errors.ts";
import { listSessionsForApi } from "./sessions.service.ts";
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
