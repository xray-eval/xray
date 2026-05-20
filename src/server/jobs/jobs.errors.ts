export class JobError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "JobError";
	}
}

/**
 * Wrap a failure from inside the bunqueue processor so the caller can surface
 * the underlying reason without unwrapping the `cause` chain. The replay-side
 * `failureReason` enum is set from the bunqueue DLQ reason; this class is for
 * test-time / log-time diagnostics.
 */
export class JobProcessingError extends JobError {
	readonly replayId: string;
	constructor(replayId: string, message: string, options?: ErrorOptions) {
		super(`Job for replay "${replayId}" failed: ${message}`, options);
		this.name = "JobProcessingError";
		this.replayId = replayId;
	}
}

/**
 * Calling code asked to enqueue a job and bunqueue refused (e.g. the queue
 * is closed). The replay row stays in `pending` analysis state; the caller
 * surfaces a 5xx and the operator restarts.
 */
export class JobEnqueueError extends JobError {
	readonly replayId: string;
	constructor(replayId: string, options?: ErrorOptions) {
		super(`Could not enqueue analysis job for replay "${replayId}"`, options);
		this.name = "JobEnqueueError";
		this.replayId = replayId;
	}
}
