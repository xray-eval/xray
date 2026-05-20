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
	OtlpError,
	OtlpProtobufNestingTooDeepError,
	TooManySpansPerRequestError,
	UnsupportedOtlpContentTypeError,
	UnsupportedWireTypeError,
} from "./otlp.errors.ts";
import { ingestOtlpTraces } from "./otlp.service.ts";
import {
	ExportTraceServiceRequestSchema,
	ExportTraceServiceResponseSchema,
	MAX_OTLP_BODY_BYTES,
} from "./otlp.types.ts";
import { decodeExportTraceServiceRequest } from "./protobuf-decode.ts";

/**
 * OTLP/HTTP receiver. Standard OTel spec path is `/v1/traces`; we
 * expose it under `/v1/otlp/v1/traces` so the existing `/v1/*` mount
 * in main.ts stays single. Exporters configured with
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://xray:8080/v1/otlp/v1/traces`
 * POST batches here.
 *
 * Both wire formats are accepted: OTLP/JSON (the xray-py SDK's
 * default) and OTLP/Protobuf (the default of every stock OTEL
 * exporter). Content-Type dispatch lives below; both code paths
 * converge on the same Valibot-narrowed request shape downstream.
 */
const OTLP_JSON_CONTENT_TYPE = "application/json";
const OTLP_PROTOBUF_CONTENT_TYPE = "application/x-protobuf";

export function createOtlpRouter(store: Store): Hono {
	const router = new Hono();

	router.post(
		"/otlp/v1/traces",
		describeRoute({
			tags: ["OTLP"],
			summary: "OTLP/HTTP traces receiver",
			description: `OpenTelemetry OTLP/HTTP traces endpoint. Accepts \`application/json\` (xray-py's preferred wire) and \`application/x-protobuf\` (every stock OTEL exporter's default). Spans without an \`xray.replay.id\` attribute are dropped silently; spans whose replay id doesn't exist are dropped silently; spans of an unrecognized vocabulary are dropped silently.`,
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
			let raw: unknown;
			if (contentType === OTLP_JSON_CONTENT_TYPE) {
				try {
					raw = await c.req.json();
				} catch (cause) {
					throw new MalformedOtlpBodyError({ cause });
				}
			} else if (contentType === OTLP_PROTOBUF_CONTENT_TYPE) {
				try {
					const buf = new Uint8Array(await c.req.arrayBuffer());
					raw = decodeExportTraceServiceRequest(buf);
				} catch (cause) {
					// Typed decoder errors (UnsupportedWireTypeError,
					// OtlpProtobufNestingTooDeepError) carry structured fields
					// the onError handler maps to specific 4xx responses; only
					// wrap genuinely unknown failures as MalformedOtlpBodyError.
					if (cause instanceof OtlpError) throw cause;
					throw new MalformedOtlpBodyError({ cause });
				}
			} else {
				throw new UnsupportedOtlpContentTypeError(contentType);
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
						max_spans: e.maxSpans,
						received: e.received,
					},
					400,
				),
			)
			.with(P.instanceOf(OtlpBodyTooLargeError), (e) =>
				c.json({ error: "body_too_large", max_bytes: e.maxBytes }, 413),
			)
			.with(P.instanceOf(UnsupportedOtlpContentTypeError), (e) =>
				c.json({ error: "unsupported_content_type", content_type: e.contentType }, 415),
			)
			.with(P.instanceOf(UnsupportedWireTypeError), (e) =>
				c.json({ error: "unsupported_wire_type", wire_type: e.wireType }, 400),
			)
			.with(P.instanceOf(OtlpProtobufNestingTooDeepError), (e) =>
				c.json({ error: "protobuf_nesting_too_deep", max_depth: e.maxDepth }, 400),
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
