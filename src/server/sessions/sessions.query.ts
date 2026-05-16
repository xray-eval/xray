import * as v from "valibot";

import { tryDecodeCursor } from "./cursor/cursor.ts";
import type { CursorPayload } from "./cursor/types.ts";

// Server-only query schema. Lives in its own file so the SPA bundle —
// which only imports wire response types from `sessions.types.ts` — can't
// pull `tryDecodeCursor` and its Node `Buffer` dependency through tree-shaking.

const MAX_AGENT_ID = 256;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
/** base64 of `{"startedAt":"…","id":"…"}` — both fields capped, so any legit cursor fits in 512 bytes. */
const MAX_CURSOR = 512;

/**
 * Pipe that turns the on-wire cursor string into a `{ startedAt, id }` pair.
 * A malformed cursor is a 400 — consistent with every other query field —
 * not a silent "ignore and return page 1", which would mask client bugs.
 */
const CursorStringSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.maxLength(MAX_CURSOR),
	v.rawTransform<string, CursorPayload>(({ dataset, addIssue, NEVER }) => {
		const decoded = tryDecodeCursor(dataset.value);
		if (decoded !== undefined) return decoded;
		addIssue({ message: "Malformed cursor" });
		return NEVER;
	}),
);

export const ListSessionsQuerySchema = v.object({
	agentId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_AGENT_ID))),
	limit: v.optional(
		v.pipe(
			v.string(),
			v.transform((s) => Number(s)),
			v.number(),
			v.integer(),
			v.minValue(1),
			v.maxValue(MAX_LIMIT),
		),
		String(DEFAULT_LIMIT),
	),
	cursor: v.optional(CursorStringSchema),
});
export type ListSessionsQuery = v.InferOutput<typeof ListSessionsQuerySchema>;
