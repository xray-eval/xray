import { eq } from "drizzle-orm";

import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { markReplayFailed } from "@/server/replays/replays.service.ts";
import { seedReplay } from "@/server/replays/replays.test-utils.ts";
import { replays } from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import type { JobRunner } from "./jobs.bunqueue.ts";
import { createJobRunner } from "./jobs.bunqueue.ts";
import { makeAnalyzePayload, makeTempJobsPath, waitFor } from "./jobs.test-utils.ts";
import type { JobName, JobProcessor } from "./jobs.types.ts";
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

// Build a `processors` map with one custom entry; the other two slots
// stay as throwing stubs so the test fails noisily if the wrong stage
// ever gets dispatched.
function buildProcessors(jobName: JobName, impl: JobProcessor): Record<JobName, JobProcessor> {
	const reject: JobProcessor = async () => {
		throw new Error("unexpected stage");
	};
	const map: Record<JobName, JobProcessor> = {
		"analyze-replay": reject,
		"calculate-metrics": reject,
		"evaluate-replay": reject,
	};
	map[jobName] = impl;
	return map;
}

describe("createJobRunner", () => {
	it("round-trip: enqueue → dispatches to the matching processor by job name", async () => {
		const processed: string[] = [];

		runner = createJobRunner({
			dataPath: tmp.path,
			processors: buildProcessors("analyze-replay", async (payload) => {
				processed.push(payload.replayId);
				return { ok: true, turnsWritten: 3, segmentsWritten: 7 };
			}),
		});

		const replayId = "00000000-0000-0000-0000-000000000123";
		const jobId = await runner.enqueue("analyze-replay", makeAnalyzePayload({ replayId }));
		expect(jobId).toBeString();

		await waitFor(() => processed.length === 1);
		expect(processed).toEqual([replayId]);
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
		const failedFires: { jobName: JobName; replayId: string }[] = [];

		runner = createJobRunner({
			dataPath: tmp.path,
			retryAttempts: 1,
			retryDelayMs: 10,
			processors: buildProcessors("analyze-replay", async () => {
				throw new Error("simulated processor crash");
			}),
			onFailed: (jobName, rid) => {
				failedFires.push({ jobName, replayId: rid });
				markReplayFailed(store, events, rid, "max_attempts_exceeded");
			},
		});

		await runner.enqueue("analyze-replay", makeAnalyzePayload({ replayId }));
		await waitFor(() => failedFires.length >= 1);
		await new Promise((r) => setTimeout(r, 50));

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("failed");
		expect(row?.failureReason).toBe("max_attempts_exceeded");
		expect(row?.analysisStep).toBeNull();
		expect(row?.finishedAt).not.toBeNull();
		expect(failedFires[0]?.jobName).toBe("analyze-replay");
		store.close();
	});
});
