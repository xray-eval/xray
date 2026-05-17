import { toJsonSchema } from "@valibot/to-json-schema";
import type { OpenAPIV3 } from "openapi-types";
import type { BaseIssue, BaseSchema } from "valibot";
import * as v from "valibot";

/**
 * Convert a Valibot schema to an OpenAPI doc schema. Returns the 3.0 form
 * because hono-openapi mixes 3.0/3.1 internally and 3.0 is the only one
 * that slots into every position (parameter, request body, response body)
 * without the `exactOptionalPropertyTypes` mismatch on the parameter slot.
 *
 * The JSON round-trip widens through `any` so the return type lands without
 * an `as` cast (banned by `.claude/rules/no-lint-suppressions.md`).
 *
 * `errorMode: "ignore"` skips `v.check(...)` predicates that have no JSON
 * Schema equivalent — the runtime validator still enforces them.
 *
 * `$schema` is stripped: `@valibot/to-json-schema` stamps every output with
 * `http://json-schema.org/draft-07/schema#`, which is the wrong dialect for
 * an OpenAPI 3.1 doc (2020-12) or AsyncAPI 3.0 doc (2020-12). Spectral and
 * other strict validators flag every embedded schema as dialect-inconsistent
 * with its parent otherwise.
 */
export function openApiSchemaFromValibot(
	schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): OpenAPIV3.SchemaObject {
	const { $schema: _, ...rest } = toJsonSchema(schema, { errorMode: "ignore" });
	return JSON.parse(JSON.stringify(rest));
}

// Wire-error response shapes shared across every server slice.
//
// Each schema describes a body shape that one or more router's `onError`
// handler emits via `c.json(...)`. Centralized here because the same envelope
// (e.g. `{error: "body_too_large", maxBytes: number}`) is produced by four
// slices — duplicating per-slice would be five copies of the same shape.
//
// The `*.types.ts` convention in code-layout §3 keeps slice-owned wire types
// per slice; this file holds the genuinely cross-slice ones.

const IssuePathStepSchema = v.object({
	type: v.string(),
	origin: v.optional(v.string()),
	key: v.optional(v.unknown()),
});

const SanitizedIssueSchema = v.object({
	kind: v.string(),
	type: v.string(),
	expected: v.optional(v.nullable(v.string())),
	received: v.optional(v.string()),
	message: v.string(),
	path: v.optional(v.array(IssuePathStepSchema)),
});

/** 400 — request body or query failed Valibot validation. */
export const ValidationErrorResponseSchema = v.object({
	error: v.string(),
	issues: v.array(SanitizedIssueSchema),
});

/** 404 — referenced session does not exist. */
export const SessionNotFoundResponseSchema = v.object({
	error: v.string(),
	sessionId: v.string(),
});

/** 404 — replay run does not exist. */
export const ReplayNotFoundResponseSchema = v.object({
	error: v.string(),
	replayId: v.string(),
});

/** 404 — turn id (idx) does not exist on the session. */
export const AudioNotFoundResponseSchema = v.object({
	error: v.string(),
	sessionId: v.string(),
	turnIdx: v.number(),
});

/** 413 — request body exceeded the per-route byte cap. */
export const BodyTooLargeResponseSchema = v.object({
	error: v.string(),
	maxBytes: v.number(),
});

/** 415 — uploaded audio used a content-type the store doesn't accept. */
export const UnsupportedContentTypeResponseSchema = v.object({
	error: v.string(),
	contentType: v.nullable(v.string()),
});

/** 422 — `tool_called` references a turn idx no row has claimed yet. */
export const UnknownTurnResponseSchema = v.object({
	error: v.string(),
	sessionId: v.string(),
	turnIdx: v.number(),
});

/** 500 — store-side data corruption or unexpected internal failure. */
export const StoreFailureResponseSchema = v.object({
	error: v.string(),
});

/** Body of every "ok, nothing else to say" response. */
export const OkResponseSchema = v.object({
	ok: v.literal(true),
});
