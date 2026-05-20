import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobRunner } from "./jobs.bunqueue.ts";
import type { AnalyzeReplayPayload } from "./jobs.types.ts";

export function makeTempJobsPath(): { path: string; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), "xray-jobs-test-"));
	return {
		path: join(dir, "bunqueue.db"),
		dispose: () => {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function makeAnalyzePayload(
	overrides: Partial<AnalyzeReplayPayload> = {},
): AnalyzeReplayPayload {
	return {
		replayId: "00000000-0000-0000-0000-000000000001",
		...overrides,
	};
}

/**
 * Poll-wait until `predicate()` returns true, with a hard timeout. Used in
 * the bunqueue round-trip test where the worker runs asynchronously inside
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

/**
 * Stub `JobRunner` for tests that need to mount the replays router but don't
 * exercise the bunqueue path. Records each enqueue so the caller can assert
 * what was scheduled without spinning up a real worker.
 */
export interface FakeJobRunner extends JobRunner {
	readonly enqueued: readonly AnalyzeReplayPayload[];
}

export function makeFakeJobRunner(): FakeJobRunner {
	const enqueued: AnalyzeReplayPayload[] = [];
	let counter = 0;
	return {
		get enqueued() {
			return enqueued;
		},
		async enqueue(payload) {
			counter += 1;
			enqueued.push(payload);
			return `fake-job-${counter}`;
		},
		async close() {
			// no-op
		},
	};
}
