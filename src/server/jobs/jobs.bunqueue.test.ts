import { eq } from "drizzle-orm";

import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { markReplayFailed } from "@/server/replays/replays.service.ts";
import { seedReplay } from "@/server/replays/replays.test-utils.ts";
import { replays } from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import type { JobRunner } from "./jobs.bunqueue.ts";
import { createJobRunner } from "./jobs.bunqueue.ts";
import { makeAnalyzePayload, makeTempJobsPath, waitFor } from "./jobs.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let runner: JobRunner | null = null;
let tmp: ReturnType<typeof makeTempJobsPath>;

beforeEach(() => {
	tmp = makeTempJobsPath();
});

afterEach(async () => {
	if (runner !== null) {
		await runner.close();
		runner = null;
	}
	tmp.dispose();
});

describe("createJobRunner", () => {
	it("round-trip: enqueue → process → onCompleted callback fires with the replay id and result", async () => {
		const processed: string[] = [];
		const completed: { replayId: string; turnsWritten: number }[] = [];

		runner = createJobRunner({
			dataPath: tmp.path,
			processor: async (payload) => {
				processed.push(payload.replayId);
				return { ok: true, turnsWritten: 3, segmentsWritten: 7 };
			},
			onCompleted: (rid, result) => {
				completed.push({ replayId: rid, turnsWritten: result.turnsWritten });
			},
		});

		const replayId = "00000000-0000-0000-0000-000000000123";
		const jobId = await runner.enqueue(makeAnalyzePayload({ replayId }));
		expect(jobId).toBeString();

		await waitFor(() => completed.length === 1);
		expect(processed).toEqual([replayId]);
		expect(completed[0]?.replayId).toBe(replayId);
		expect(completed[0]?.turnsWritten).toBe(3);
	});

	it("onFailed → markReplayFailed: a processor that always throws ends with the row stamped `failed` + `max_attempts_exceeded`", async () => {
		const store = makeTempStore();
		const events = makeReplayEvents();
		const { replayId } = await seedReplay(store);
		// Park the row in `analyzing` to mirror the real flow after
		// enqueueAnalysis. markReplayFailed otherwise short-circuits on
		// `pending` only because of its non-terminal guard, but `analyzing`
		// is the lifecycle bunqueue actually fails out of.
		store.db
			.update(replays)
			.set({ lifecycleState: "analyzing", analysisStep: "vad" })
			.where(eq(replays.id, replayId))
			.run();
		const failedFires: string[] = [];

		runner = createJobRunner({
			dataPath: tmp.path,
			retryAttempts: 1,
			retryDelayMs: 10,
			processor: async () => {
				throw new Error("simulated processor crash");
			},
			onFailed: (rid, _err) => {
				failedFires.push(rid);
				markReplayFailed(store, events, rid, "max_attempts_exceeded");
			},
		});

		await runner.enqueue(makeAnalyzePayload({ replayId }));
		await waitFor(() => failedFires.length >= 1);
		// Give bunqueue a beat in case it fires `failed` more than once across
		// the (single) attempt path; markReplayFailed must remain idempotent.
		await new Promise((r) => setTimeout(r, 50));

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("failed");
		expect(row?.failureReason).toBe("max_attempts_exceeded");
		expect(row?.analysisStep).toBeNull();
		expect(row?.finishedAt).not.toBeNull();
		store.close();
	});
});
