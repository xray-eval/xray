import * as v from "valibot";

import { ReplayIdSchema } from "@/server/replays/replays.types.ts";

/**
 * Every job in the analyze chain works on one replay id. The payload is
 * identical across stages — `analyze-replay`, `calculate-metrics`,
 * `evaluate-replay`. The worker pulls everything else from the store.
 */
export const JobPayloadSchema = v.object({
	replayId: ReplayIdSchema,
});
export type JobPayload = v.InferOutput<typeof JobPayloadSchema>;

/**
 * Job name = stage name. The HTTP `/analyze` endpoint enqueues
 * `analyze-replay`; each stage's processor enqueues the next on success.
 */
export const JOB_NAMES = ["analyze-replay", "calculate-metrics", "evaluate-replay"] as const;
export type JobName = (typeof JOB_NAMES)[number];

/**
 * Generic processor signature. Each stage returns `{ ok: true }` plus
 * stage-specific telemetry as concrete fields (e.g. `analyze-replay`
 * returns `turnsWritten` / `segmentsWritten`). Bunqueue carries the
 * widened `JobResult` on its event surface, but each processor's
 * concrete return type stays inferrable at the call site — tests can
 * read `result.turnsWritten` directly.
 *
 * The chain-internal enqueue of the next stage happens inside the
 * processor body, not by inspecting the return value.
 */
export type JobProcessor = (payload: JobPayload) => Promise<JobResult>;

export interface JobResult {
	readonly ok: true;
}
