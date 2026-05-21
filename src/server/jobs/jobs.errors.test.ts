import { JobEnqueueError, JobError, JobProcessingError } from "./jobs.errors.ts";
import { describe, expect, it } from "bun:test";

describe("JobError subclasses", () => {
	it("JobProcessingError carries replayId + name + parentage", () => {
		const err = new JobProcessingError("r-1", "VAD crashed");
		expect(err).toBeInstanceOf(JobError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("JobProcessingError");
		expect(err.replayId).toBe("r-1");
		expect(err.message).toContain("r-1");
		expect(err.message).toContain("VAD crashed");
	});

	it("JobProcessingError propagates `cause` for stack chaining", () => {
		const underlying = new Error("disk full");
		const err = new JobProcessingError("r-2", "tx failed", { cause: underlying });
		expect(err.cause).toBe(underlying);
	});

	it("JobEnqueueError carries replayId + name + parentage", () => {
		const err = new JobEnqueueError("r-3");
		expect(err).toBeInstanceOf(JobError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("JobEnqueueError");
		expect(err.replayId).toBe("r-3");
		expect(err.message).toContain("r-3");
	});

	it("JobEnqueueError propagates `cause`", () => {
		const underlying = new Error("queue closed");
		const err = new JobEnqueueError("r-4", { cause: underlying });
		expect(err.cause).toBe(underlying);
	});

	it("JobError base class sets its own name", () => {
		const err = new JobError("generic");
		expect(err.name).toBe("JobError");
		expect(err).toBeInstanceOf(Error);
	});
});
