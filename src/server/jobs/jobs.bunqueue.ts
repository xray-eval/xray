import { Bunqueue } from "bunqueue/client";

import { JobEnqueueError } from "./jobs.errors.ts";
import type { AnalyzeReplayPayload, AnalyzeReplayResult, ProgressStep } from "./jobs.types.ts";

export type AnalyzeProcessor = (payload: AnalyzeReplayPayload) => Promise<AnalyzeReplayResult>;

export interface JobRunnerOptions {
	dataPath: string;
	concurrency?: number;
	/** Override the default (3) bunqueue retry count. Tests use 1 to skip retries. */
	retryAttempts?: number;
	/** Override the default (2000ms) bunqueue retry base delay. Tests use 10ms. */
	retryDelayMs?: number;
	processor: AnalyzeProcessor;
	onProgress?: (replayId: string, percent: number, step: ProgressStep | null) => void;
	onCompleted?: (replayId: string, result: AnalyzeReplayResult) => void;
	onFailed?: (replayId: string, error: Error) => void;
}

export interface JobRunner {
	enqueue(payload: AnalyzeReplayPayload): Promise<string>;
	close(): Promise<void>;
}

const QUEUE_NAME = "analyze-replay";
const JOB_NAME = "run";
const DEFAULT_CONCURRENCY = 1;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Wrap bunqueue@2.7.12 with an xray-shaped surface: one queue named
 * `analyze-replay`, payload + result typed against our domain, progress
 * events relayed by replay id rather than the bunqueue job. The wrapper
 * keeps a `Map<jobId, replayId>` so progress listeners can resolve the
 * caller-facing identifier even when bunqueue surfaces `job` as `null`
 * (which it does during shutdown / cancellation paths).
 */
export function createJobRunner(opts: JobRunnerOptions): JobRunner {
	const jobIdToReplayId = new Map<string, string>();

	const retryAttempts = opts.retryAttempts ?? RETRY_ATTEMPTS;
	const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
	const queue = new Bunqueue<AnalyzeReplayPayload, AnalyzeReplayResult>(QUEUE_NAME, {
		embedded: true,
		dataPath: opts.dataPath,
		concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
		retry: { maxAttempts: retryAttempts, strategy: "exponential", delay: retryDelayMs },
		processor: async (job) => opts.processor(job.data),
	});

	// bunqueue's EventEmitter emits an `error` event (with `{context, jobId}`
	// attached) when its internal SQLite writes fail — e.g. SQLITE_IOERR_VNODE,
	// SQLITE_FULL, or a transient lock conflict during DLQ persistence. An
	// unhandled `error` on an EventEmitter crashes the host process; bunqueue
	// still proceeds to emit `failed` for the caller's onFailed hook even when
	// its own DLQ write fails (see bunqueue/dist/client/worker/processor.js).
	// We log + swallow so the lifecycle markFailed path still runs.
	queue.on("error", (err: unknown) => {
		console.error("bunqueue internal error (swallowed; onFailed still fires)", err);
	});

	if (opts.onProgress !== undefined) {
		const onProgress = opts.onProgress;
		queue.on("progress", (job, percent) => {
			if (job === null) return;
			const replayId = jobIdToReplayId.get(job.id) ?? job.data.replayId;
			onProgress(replayId, percent, null);
		});
	}

	if (opts.onCompleted !== undefined) {
		const onCompleted = opts.onCompleted;
		queue.on("completed", (job, result) => {
			jobIdToReplayId.delete(job.id);
			onCompleted(job.data.replayId, result);
		});
	}

	if (opts.onFailed !== undefined) {
		const onFailed = opts.onFailed;
		queue.on("failed", (job, error) => {
			jobIdToReplayId.delete(job.id);
			onFailed(job.data.replayId, error);
		});
	}

	return {
		async enqueue(payload) {
			try {
				const job = await queue.add(JOB_NAME, payload, { attempts: retryAttempts });
				jobIdToReplayId.set(job.id, payload.replayId);
				return job.id;
			} catch (cause) {
				throw new JobEnqueueError(payload.replayId, { cause });
			}
		},
		async close() {
			await queue.close();
		},
	};
}
