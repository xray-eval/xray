import { Bunqueue } from "bunqueue/client";

import { JobEnqueueError } from "./jobs.errors.ts";
import type { JobName, JobPayload, JobProcessor, JobResult } from "./jobs.types.ts";
import { JOB_NAMES } from "./jobs.types.ts";

function isJobName(value: string): value is JobName {
	for (const name of JOB_NAMES) {
		if (name === value) return true;
	}
	return false;
}

export interface JobRunnerOptions {
	dataPath: string;
	/**
	 * Number of jobs the worker processes in parallel (across all job names).
	 * Default 1. Peak memory per worker is ~117 MB at the 50 MB WAV cap for
	 * the analyze-replay stage; calculate-metrics + evaluate-replay are
	 * orders of magnitude lighter. `concurrency * 120 MB` is a useful
	 * rule-of-thumb for sizing — bumping above 1 needs proportional RAM.
	 */
	concurrency?: number;
	retryAttempts?: number;
	retryDelayMs?: number;
	/**
	 * One processor per job name. The bunqueue dispatcher routes by
	 * `job.name`; adding a new chain stage = add an entry here + add the
	 * name to `JOB_NAMES`.
	 */
	processors: Readonly<Record<JobName, JobProcessor>>;
	/**
	 * Last-resort safety net: bunqueue emits `failed` for the parent caller
	 * after every processor + every retry has failed. Each stage's processor
	 * is expected to catch its own errors and stamp `lifecycle_state='failed'`
	 * with the stage-specific `failure_reason` *inside* its body; this hook
	 * only fires if the processor itself crashed before it could stamp
	 * anything (or if bunqueue gave up on stalls / max-attempts).
	 */
	onFailed?: (jobName: JobName, replayId: string, error: Error) => void;
}

export interface JobRunner {
	enqueue(jobName: JobName, payload: JobPayload): Promise<string>;
	close(): Promise<void>;
}

const QUEUE_NAME = "analyze-chain";
const DEFAULT_CONCURRENCY = 1;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Wrap bunqueue@2.7.12 with an xray-shaped surface. One queue
 * (`analyze-chain`) carries every stage of the 3-job pipeline; the
 * dispatcher routes by `job.name`. Same `bunqueue.db` for all stages —
 * keeps the single-image / one-volume promise.
 *
 * Progress is not threaded through bunqueue's `job.updateProgress` channel;
 * each processor emits progress + state directly onto the local
 * `ReplayEvents` pub/sub the SSE handler subscribes to. Routing progress
 * through bunqueue would require passing the `job` argument into the
 * processor closure for zero behavioural gain.
 */
export function createJobRunner(opts: JobRunnerOptions): JobRunner {
	const retryAttempts = opts.retryAttempts ?? RETRY_ATTEMPTS;
	const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
	const queue = new Bunqueue<JobPayload, JobResult>(QUEUE_NAME, {
		embedded: true,
		dataPath: opts.dataPath,
		concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
		retry: { maxAttempts: retryAttempts, strategy: "exponential", delay: retryDelayMs },
		processor: async (job) => {
			if (!isJobName(job.name)) {
				throw new Error(`No processor registered for job name "${job.name}"`);
			}
			return opts.processors[job.name](job.data);
		},
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

	if (opts.onFailed !== undefined) {
		const onFailed = opts.onFailed;
		queue.on("failed", (job, error) => {
			// `job.name` is `string` on bunqueue's typing; narrow against
			// our closed catalog so a stray queue entry surfaces in logs
			// instead of poisoning the typed callback.
			if (!isJobName(job.name)) {
				console.error(`bunqueue 'failed' event for unknown job "${job.name}"`, error);
				return;
			}
			onFailed(job.name, job.data.replayId, error);
		});
	}

	return {
		async enqueue(jobName, payload) {
			try {
				const job = await queue.add(jobName, payload, { attempts: retryAttempts });
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
