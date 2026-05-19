import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { match, P } from "ts-pattern";
import * as v from "valibot";

import {
	BodyTooLargeResponseSchema,
	openApiSchemaFromValibot,
	StoreFailureResponseSchema,
	UnsupportedContentTypeResponseSchema,
	ValidationErrorResponseSchema,
} from "@/server/core/types.ts";
import { sanitizeIssues } from "@/server/sanitize-issues/sanitize-issues.ts";
import type { Store } from "@/server/store/store.ts";

import {
	InvalidOtlpBodyError,
	MalformedOtlpBodyError,
	OtlpBodyTooLargeError,
	TooManySpansPerRequestError,
	UnsupportedOtlpContentTypeError,
} from "./otlp.errors.ts";
import { ingestOtlpTraces } from "./otlp.service.ts";
import {
	ExportTraceServiceRequestSchema,
	ExportTraceServiceResponseSchema,
	MAX_OTLP_BODY_BYTES,
} from "./otlp.types.ts";

/**
 * OTLP/HTTP receiver. Standard OTel spec path is `/v1/traces`; we expose
 * it under `/v1/otlp/v1/traces` so the existing `/v1/*` mount in main.ts
 * stays single. Exporters configured with
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://xray:8080/v1/otlp/v1/traces`
 * will POST batches here.
 *
 * Body is OTLP/JSON only. Protobuf is the on-the-wire default for OTel
 * exporters but the SDK we ship configures the JSON path so xray has no
 * protobuf decoder dependency.
 */
const OTLP_JSON_CONTENT_TYPE = "application/json";

export function createOtlpRouter(store: Store): Hono {
	const router = new Hono();

	router.post(
		"/otlp/v1/traces",
		describeRoute({
			tags: ["OTLP"],
			summary: "OTLP/HTTP traces receiver",
			description: `OpenTelemetry OTLP/HTTP traces endpoint. Accepts \`application/json\` (Protobuf is rejected with 415). Spans without an \`xray.replay.id\` resource attribute are dropped silently; spans whose replay id doesn't exist are dropped silently; spans of an unrecognized vocabulary are dropped silently. See \`docs/WIRE.md\` for recognized vocabularies and the fields extracted from each.`,
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: openApiSchemaFromValibot(ExportTraceServiceRequestSchema),
					},
				},
			},
			responses: {
				"200": {
					description: "Spans accepted. Body reports `partialSuccess.rejectedSpans`.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(ExportTraceServiceResponseSchema),
						},
					},
				},
				"400": {
					description: "Body failed OTLP shape validation or exceeded spans-per-request cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(ValidationErrorResponseSchema) },
					},
				},
				"413": {
					description: "Body exceeded the per-request byte cap.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(BodyTooLargeResponseSchema) },
					},
				},
				"415": {
					description: "Content-Type is not application/json.",
					content: {
						"application/json": {
							schema: openApiSchemaFromValibot(UnsupportedContentTypeResponseSchema),
						},
					},
				},
				"500": {
					description: "Unhandled internal failure.",
					content: {
						"application/json": { schema: openApiSchemaFromValibot(StoreFailureResponseSchema) },
					},
				},
			},
		}),
		bodyLimit({
			maxSize: MAX_OTLP_BODY_BYTES,
			onError: () => {
				throw new OtlpBodyTooLargeError(MAX_OTLP_BODY_BYTES);
			},
		}),
		async (c) => {
			const contentType = (c.req.header("content-type") ?? null)?.split(";")[0]?.trim() ?? null;
			if (contentType !== OTLP_JSON_CONTENT_TYPE) {
				throw new UnsupportedOtlpContentTypeError(contentType);
			}
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch (cause) {
				throw new MalformedOtlpBodyError({ cause });
			}
			const parsed = v.safeParse(ExportTraceServiceRequestSchema, raw);
			if (!parsed.success) {
				throw new InvalidOtlpBodyError(parsed.issues);
			}
			const { response } = ingestOtlpTraces(store, parsed.output);
			return c.json(response);
		},
	);

	router.onError((err, c) =>
		match(err)
			.with(P.instanceOf(InvalidOtlpBodyError), (e) =>
				c.json({ error: "invalid_otlp_body", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(MalformedOtlpBodyError), (e) =>
				c.json({ error: "invalid_otlp_body", issues: sanitizeIssues(e.issues) }, 400),
			)
			.with(P.instanceOf(TooManySpansPerRequestError), (e) =>
				c.json(
					{
						error: "too_many_spans_per_request",
						maxSpans: e.maxSpans,
						received: e.received,
					},
					400,
				),
			)
			.with(P.instanceOf(OtlpBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", maxBytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(UnsupportedOtlpContentTypeError), (e) =>
				c.json({ error: "unsupported_content_type", contentType: e.contentType }, 415),
			)
			.with(P.instanceOf(Error), (e) => {
				console.error("unhandled error during otlp ingest", e);
				return c.json({ error: "internal_error" }, 500);
			})
			.otherwise((e) => {
				throw e;
			}),
	);

	return router;
}
