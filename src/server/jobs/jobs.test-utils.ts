import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobRunner } from "./jobs.bunqueue.ts";
import type { JobName, JobPayload } from "./jobs.types.ts";

export function makeTempJobsPath(): { path: string; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), "xray-jobs-test-"));
	return {
		path: join(dir, "bunqueue.db"),
		dispose: () => {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function makeAnalyzePayload(overrides: Partial<JobPayload> = {}): JobPayload {
	return {
		replayId: "00000000-0000-0000-0000-000000000001",
		...overrides,
	};
}

/**
 * Poll-wait until `predicate()` returns true, with a hard timeout. Used in
 * bunqueue round-trip tests where the worker runs asynchronously inside
 * the same process — we can't `await` the job directly, so we wait on the
 * side-effect that the listener observes.
 */
export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
	pollIntervalMs = 50,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor: predicate did not resolve within ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

export interface EnqueuedJob {
	name: JobName;
	payload: JobPayload;
}

/**
 * Stub `JobRunner` for tests that need to mount the replays router but
 * don't exercise the bunqueue path. Records every (job name, payload) tuple
 * so the caller can assert exactly what got scheduled, including which
 * stage the chain reached.
 */
export interface FakeJobRunner extends JobRunner {
	readonly enqueued: readonly EnqueuedJob[];
}

export function makeFakeJobRunner(): FakeJobRunner {
	const enqueued: EnqueuedJob[] = [];
	let counter = 0;
	return {
		get enqueued() {
			return enqueued;
		},
		async enqueue(name, payload) {
			counter += 1;
			enqueued.push({ name, payload });
			return `fake-job-${counter}`;
		},
		async close() {
			// no-op
		},
	};
}
