import { eq } from "drizzle-orm";

import {
	createReplayRun,
	finishReplayRun,
	getReplayRun,
	markReplayRunRunning,
	sweepOrphanedReplayRuns,
	updateReplayRunProgress,
} from "./replay-runs-repo.ts";
import { sessions } from "./schema.ts";
import { saveSession } from "./sessions-repo.ts";
import { makeReplayRunInput, makeSession, makeTempStore } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

function seedSource(store: ReturnType<typeof makeTempStore>, id = "sess-1") {
	saveSession(store.db, makeSession({ id }));
}

describe("replay-runs-repo", () => {
	it("round-trips a created replay run", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r-1", targetSessionId: "tgt-1" }));
		const row = getReplayRun(store.db, "r-1");
		expect(row?.id).toBe("r-1");
		expect(row?.targetSessionId).toBe("tgt-1");
		expect(row?.status).toBe("pending");
		expect(row?.progressCompleted).toBe(0);
		store.close();
	});

	it("returns undefined for an unknown id", () => {
		const store = makeTempStore();
		expect(getReplayRun(store.db, "nope")).toBeUndefined();
		store.close();
	});

	it("rejects duplicate target_session_id (UNIQUE constraint)", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "a", targetSessionId: "shared" }));
		expect(() =>
			createReplayRun(store.db, makeReplayRunInput({ id: "b", targetSessionId: "shared" })),
		).toThrow();
		store.close();
	});

	it("cascades deletes of the source session to the run", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r" }));
		store.db.delete(sessions).where(eq(sessions.id, "sess-1")).run();
		expect(getReplayRun(store.db, "r")).toBeUndefined();
		store.close();
	});

	it("flips pending → running", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r", status: "pending" }));
		markReplayRunRunning(store.db, "r");
		expect(getReplayRun(store.db, "r")?.status).toBe("running");
		store.close();
	});

	it("markReplayRunRunning is a no-op when not pending", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r", status: "running" }));
		finishReplayRun(store.db, "r", "completed", { finishedAt: "2026-05-16T12:01:00.000Z" });
		markReplayRunRunning(store.db, "r");
		expect(getReplayRun(store.db, "r")?.status).toBe("completed");
		store.close();
	});

	it("updates progress without touching status", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(
			store.db,
			makeReplayRunInput({ id: "r", status: "running", progressTotal: 10 }),
		);
		updateReplayRunProgress(store.db, "r", { completed: 3 });
		const row = getReplayRun(store.db, "r");
		expect(row?.progressCompleted).toBe(3);
		expect(row?.status).toBe("running");
		store.close();
	});

	it("optionally updates progress_total alongside completed", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r", status: "running", progressTotal: 0 }));
		updateReplayRunProgress(store.db, "r", { completed: 1, total: 5 });
		const row = getReplayRun(store.db, "r");
		expect(row?.progressCompleted).toBe(1);
		expect(row?.progressTotal).toBe(5);
		store.close();
	});

	it("finishReplayRun(completed) transitions running → completed and stamps finishedAt", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r", status: "running" }));
		finishReplayRun(store.db, "r", "completed", { finishedAt: "2026-05-16T12:05:00.000Z" });
		const row = getReplayRun(store.db, "r");
		expect(row?.status).toBe("completed");
		expect(row?.finishedAt).toBe("2026-05-16T12:05:00.000Z");
		expect(row?.error).toBeNull();
		store.close();
	});

	it("finishReplayRun(failed) records the error message", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r", status: "running" }));
		finishReplayRun(store.db, "r", "failed", {
			finishedAt: "2026-05-16T12:05:00.000Z",
			error: "webhook 500",
		});
		const row = getReplayRun(store.db, "r");
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe("webhook 500");
		store.close();
	});

	it("finishReplayRun is a no-op once the row is already terminal", () => {
		// The boot sweep already moved a row to `failed`; a late worker callback
		// then tries to mark it `completed`. The terminal state must stick so
		// the UI doesn't flip back to a misleading "completed" after a crash.
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "r", status: "running" }));
		finishReplayRun(store.db, "r", "failed", {
			finishedAt: "2026-05-16T12:01:00.000Z",
			error: "orphaned by restart",
		});
		finishReplayRun(store.db, "r", "completed", { finishedAt: "2026-05-16T12:05:00.000Z" });
		const row = getReplayRun(store.db, "r");
		expect(row?.status).toBe("failed");
		expect(row?.error).toBe("orphaned by restart");
		store.close();
	});

	it("sweepOrphanedReplayRuns flips every running row to failed and counts them", () => {
		const store = makeTempStore();
		seedSource(store);
		createReplayRun(store.db, makeReplayRunInput({ id: "a", status: "running" }));
		createReplayRun(store.db, makeReplayRunInput({ id: "b", status: "running" }));
		createReplayRun(store.db, makeReplayRunInput({ id: "c", status: "pending" }));
		createReplayRun(store.db, makeReplayRunInput({ id: "d", status: "completed" }));
		const swept = sweepOrphanedReplayRuns(store.db, "2026-05-17T00:00:00.000Z");
		expect(swept).toBe(2);
		expect(getReplayRun(store.db, "a")?.status).toBe("failed");
		expect(getReplayRun(store.db, "a")?.error).toBe("orphaned by restart");
		expect(getReplayRun(store.db, "b")?.status).toBe("failed");
		// `pending` is untouched — the boot sweep only kills *active* workers.
		expect(getReplayRun(store.db, "c")?.status).toBe("pending");
		expect(getReplayRun(store.db, "d")?.status).toBe("completed");
		store.close();
	});

	it("rejects status values outside the CHECK constraint", () => {
		// The DB CHECK constraint guards against rows the typed writers can't
		// produce — manual DB edits, a future migration mistake. The expect-error
		// is the test surface to that constraint; in production the type system
		// already prevents this call shape.
		const store = makeTempStore();
		seedSource(store);
		expect(() =>
			createReplayRun(store.db, {
				...makeReplayRunInput({ id: "r" }),
				// @ts-expect-error — deliberately violating the type to exercise the DB CHECK
				status: "weird",
			}),
		).toThrow();
		store.close();
	});
});
