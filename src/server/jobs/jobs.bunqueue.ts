import { Bunqueue } from "bunqueue/client";

import { JobEnqueueError } from "./jobs.errors.ts";
import type { AnalyzeReplayPayload, AnalyzeReplayResult } from "./jobs.types.ts";

export type AnalyzeProcessor = (payload: AnalyzeReplayPayload) => Promise<AnalyzeReplayResult>;

export interface JobRunnerOptions {
	dataPath: string;
	/**
	 * Number of replays the worker processes in parallel. Default 1.
	 *
	 * Peak memory per worker is ~117 MB at the 50 MB WAV cap (raw bytes +
	 * stereo Int16 channels + 16 kHz downsampled buffers + VAD frame array).
	 * `concurrency * 120 MB` is a useful rule-of-thumb when sizing the
	 * container. Bumping above 1 needs proportional RAM headroom.
	 */
	concurrency?: number;
	/** Override the default (3) bunqueue retry count. Tests use 1 to skip retries. */
	retryAttempts?: number;
	/** Override the default (2000ms) bunqueue retry base delay. Tests use 10ms. */
	retryDelayMs?: number;
	processor: AnalyzeProcessor;
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
 * `analyze-replay`, payload + result typed against our domain, lifecycle
 * callbacks keyed by replay id rather than the bunqueue job id.
 *
 * Progress is not threaded through bunqueue's `job.updateProgress` channel;
 * the analyze-replay processor emits progress directly onto the local
 * `ReplayEvents` pub/sub (which is what the SSE handler subscribes to).
 * Routing progress through bunqueue would require passing the `job` argument
 * into the processor closure for zero behavioural gain.
 */
export function createJobRunner(opts: JobRunnerOptions): JobRunner {
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

	if (opts.onCompleted !== undefined) {
		const onCompleted = opts.onCompleted;
		queue.on("completed", (job, result) => {
			onCompleted(job.data.replayId, result);
		});
	}

	if (opts.onFailed !== undefined) {
		const onFailed = opts.onFailed;
		queue.on("failed", (job, error) => {
			onFailed(job.data.replayId, error);
		});
	}

	return {
		async enqueue(payload) {
			try {
				const job = await queue.add(JOB_NAME, payload, { attempts: retryAttempts });
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
