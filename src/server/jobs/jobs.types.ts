import * as v from "valibot";

import { ReplayIdSchema } from "@/server/replays/replays.types.ts";

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
