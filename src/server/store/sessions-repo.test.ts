import { getSession, listSessions, markSessionEnded, saveSession } from "./sessions-repo.ts";
import { makeSession, makeTempStore } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("sessions-repo", () => {
	it("round-trips a saved session", () => {
		const store = makeTempStore();
		const sess = makeSession({
			id: "s-1",
			source: "adapter",
			provider: "elevenlabs",
			agentId: "agent-x",
			startedAt: "2026-05-16T12:00:00.000Z",
			endedAt: "2026-05-16T12:05:00.000Z",
			durationMs: 300_000,
		});
		saveSession(store.db, sess);
		expect(getSession(store.db, "s-1")).toEqual(sess);
		store.close();
	});

	it("upserts on conflicting id", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "s-1", endedAt: null }));
		saveSession(store.db, makeSession({ id: "s-1", endedAt: "2026-05-16T13:00:00.000Z" }));
		expect(getSession(store.db, "s-1")?.endedAt).toBe("2026-05-16T13:00:00.000Z");
		store.close();
	});

	it("markSessionEnded is terminal — second call is a no-op", () => {
		// Once endedAt is set, a second session_ended (e.g. a retried POST that
		// the client thinks failed) must not overwrite the canonical end time.
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "s-1", endedAt: null }));
		markSessionEnded(store.db, "s-1", "2026-05-16T13:00:00.000Z", 300_000);
		markSessionEnded(store.db, "s-1", "2026-05-16T14:00:00.000Z", 999_999);
		const row = getSession(store.db, "s-1");
		expect(row?.endedAt).toBe("2026-05-16T13:00:00.000Z");
		expect(row?.durationMs).toBe(300_000);
		store.close();
	});

	it("does not regress startedAt past its existing value", () => {
		// A late session_started arriving after a stub (whose startedAt was
		// derived from the first turn's timestamp) must not push the canonical
		// startedAt forward past turns already on disk.
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "s-1", startedAt: "2026-05-16T12:00:01.000Z" }));
		saveSession(store.db, makeSession({ id: "s-1", startedAt: "2026-05-16T12:00:02.000Z" }));
		expect(getSession(store.db, "s-1")?.startedAt).toBe("2026-05-16T12:00:01.000Z");
		store.close();
	});

	it("rolls startedAt back to an earlier value (MIN-merge)", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "s-1", startedAt: "2026-05-16T12:00:01.000Z" }));
		saveSession(store.db, makeSession({ id: "s-1", startedAt: "2026-05-16T12:00:00.000Z" }));
		expect(getSession(store.db, "s-1")?.startedAt).toBe("2026-05-16T12:00:00.000Z");
		store.close();
	});

	it("does not un-end a previously-ended session", () => {
		const store = makeTempStore();
		saveSession(
			store.db,
			makeSession({ id: "s-1", endedAt: "2026-05-16T13:00:00.000Z", durationMs: 300_000 }),
		);
		saveSession(store.db, makeSession({ id: "s-1", endedAt: null, durationMs: null }));
		const row = getSession(store.db, "s-1");
		expect(row?.endedAt).toBe("2026-05-16T13:00:00.000Z");
		expect(row?.durationMs).toBe(300_000);
		store.close();
	});

	it("returns undefined for unknown id", () => {
		const store = makeTempStore();
		expect(getSession(store.db, "missing")).toBeUndefined();
		store.close();
	});

	it("lists sessions newest-first by started_at", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "old", startedAt: "2026-05-15T10:00:00.000Z" }));
		saveSession(store.db, makeSession({ id: "mid", startedAt: "2026-05-15T12:00:00.000Z" }));
		saveSession(store.db, makeSession({ id: "new", startedAt: "2026-05-16T08:00:00.000Z" }));
		const ids = listSessions(store.db).map((s) => s.id);
		expect(ids).toEqual(["new", "mid", "old"]);
		store.close();
	});

	it("filters by source", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "a", source: "adapter", provider: "elevenlabs" }));
		saveSession(store.db, makeSession({ id: "b", source: "ingest", provider: null }));
		const onlyIngest = listSessions(store.db, { source: "ingest" });
		expect(onlyIngest).toHaveLength(1);
		expect(onlyIngest[0]?.id).toBe("b");
		store.close();
	});

	it("filters by agentId", () => {
		const store = makeTempStore();
		saveSession(store.db, makeSession({ id: "a", agentId: "agent-x" }));
		saveSession(store.db, makeSession({ id: "b", agentId: "agent-y" }));
		const onlyY = listSessions(store.db, { agentId: "agent-y" });
		expect(onlyY).toHaveLength(1);
		expect(onlyY[0]?.id).toBe("b");
		store.close();
	});

	it("respects limit", () => {
		const store = makeTempStore();
		for (let i = 0; i < 5; i++) {
			saveSession(
				store.db,
				makeSession({ id: `s-${i}`, startedAt: `2026-05-16T12:0${i}:00.000Z` }),
			);
		}
		expect(listSessions(store.db, { limit: 2 })).toHaveLength(2);
		store.close();
	});
});
