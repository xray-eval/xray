import * as v from "valibot";

import { ReplayIdSchema } from "@/server/replays/replays.types.ts";
import { ANALYSIS_STEPS } from "@/server/store/types.ts";

/**
 * Payload of an `analyze-replay` job. Only the replay id — the worker pulls
 * everything else from the store (audio path, run config).
 */
export const AnalyzeReplayPayloadSchema = v.object({
	replayId: ReplayIdSchema,
});
export type AnalyzeReplayPayload = v.InferOutput<typeof AnalyzeReplayPayloadSchema>;

/** Result of a successful `analyze-replay` job. */
export const AnalyzeReplayResultSchema = v.object({
	ok: v.literal(true),
	turnsWritten: v.number(),
	segmentsWritten: v.number(),
});
export type AnalyzeReplayResult = v.InferOutput<typeof AnalyzeReplayResultSchema>;

/**
 * Progress payload emitted by the worker via `job.updateProgress(percent, step)`.
 * bunqueue's `progress` event delivers the numeric percent; the step label
 * lives on the job's metadata and is read back via the queue's progress
 * subscription.
 */
export const PROGRESS_STEPS = ANALYSIS_STEPS;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];
