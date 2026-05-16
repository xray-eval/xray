import * as v from "valibot";

/**
 * Decoded form of an opaque pagination cursor for the sessions list. The wire
 * format is base64url over the JSON of this object — `cursor.ts` handles the
 * codec. Schemas are colocated with the codec because both sides need them.
 */
export const CursorPayloadSchema = v.object({
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
	id: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
});
export type CursorPayload = v.InferOutput<typeof CursorPayloadSchema>;
