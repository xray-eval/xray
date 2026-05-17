import { and, count, desc, eq, inArray } from "drizzle-orm";

import { replayRuns } from "./schema.ts";
import type { StoreDb } from "./store.ts";
import type { ReplayRunInput, ReplayRunRow, ReplayRunStatus } from "./types.ts";

/**
 * Insert a new replay run. Caller chooses the id and the initial
 * `status='pending'` / `'running'` — the row is meaningless without an
 * active worker, so the writer sets the initial state in one hop.
 */
export function createReplayRun(db: StoreDb, input: ReplayRunInput): void {
	db.insert(replayRuns).values(input).run();
}

export function getReplayRun(db: StoreDb, id: string): ReplayRunRow | undefined {
	return db.select().from(replayRuns).where(eq(replayRuns.id, id)).get();
}

/** All replay runs whose source is `sessionId`, newest-first. Used by the
 *  inspector's Replays tab. Replay counts per session are small; no pagination. */
export function listReplayRunsBySourceSession(db: StoreDb, sessionId: string): ReplayRunRow[] {
	return db
		.select()
		.from(replayRuns)
		.where(eq(replayRuns.sourceSessionId, sessionId))
		.orderBy(desc(replayRuns.startedAt), desc(replayRuns.id))
		.all();
}

export interface UpdateProgressOptions {
	completed: number;
	total?: number;
}

/** Bump `progress_completed` (and optionally `progress_total`) without touching status. */
export function updateReplayRunProgress(
	db: StoreDb,
	id: string,
	opts: UpdateProgressOptions,
): void {
	db.update(replayRuns)
		.set({
			progressCompleted: opts.completed,
			...(opts.total !== undefined ? { progressTotal: opts.total } : {}),
		})
		.where(eq(replayRuns.id, id))
		.run();
}

export interface FinishReplayRunOptions {
	finishedAt: string;
	/** Required when status='failed', otherwise omit. */
	error?: string;
}

/**
 * Transition a row to a terminal status (`completed` or `failed`). The
 * where-clause excludes already-terminal rows so a late worker callback
 * cannot overwrite a row the boot sweep already moved to `failed`.
 */
export function finishReplayRun(
	db: StoreDb,
	id: string,
	status: Extract<ReplayRunStatus, "completed" | "failed">,
	opts: FinishReplayRunOptions,
): void {
	db.update(replayRuns)
		.set({
			status,
			finishedAt: opts.finishedAt,
			error: opts.error ?? null,
		})
		.where(and(eq(replayRuns.id, id), inArray(replayRuns.status, ["pending", "running"])))
		.run();
}

/** Flip status pending → running. */
export function markReplayRunRunning(db: StoreDb, id: string): void {
	db.update(replayRuns)
		.set({ status: "running" })
		.where(and(eq(replayRuns.id, id), eq(replayRuns.status, "pending")))
		.run();
}

/**
 * Sweep orphaned runs on startup: any `status='running'` row predates the
 * current process (single-writer model). Mark them `failed` so the UI shows
 * them as broken instead of stuck "in progress" forever.
 *
 * Returns the number of rows swept — callers log it on boot.
 */
export function sweepOrphanedReplayRuns(db: StoreDb, finishedAt: string): number {
	const swept =
		db.select({ n: count() }).from(replayRuns).where(eq(replayRuns.status, "running")).get()?.n ??
		0;
	if (swept === 0) return 0;
	db.update(replayRuns)
		.set({
			status: "failed",
			finishedAt,
			error: "orphaned by restart",
		})
		.where(eq(replayRuns.status, "running"))
		.run();
	return swept;
}
