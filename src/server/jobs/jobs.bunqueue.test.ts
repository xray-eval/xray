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
});
