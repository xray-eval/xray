import * as v from "valibot";

/**
 * OTLP/JSON shape — minimal model of what we consume. Spec:
 * https://opentelemetry.io/docs/specs/otlp/
 *
 * We model only the fields we read. OTLP/JSON sends attribute values as
 * `{stringValue: "...", intValue: 123, boolValue: true, doubleValue: 1.5, …}`
 * objects keyed by the value's type — we accept the union and project to a
 * plain JS value at parse time.
 */
const AnyValueSchema = v.union([
	v.object({ stringValue: v.string() }),
	v.object({ intValue: v.union([v.string(), v.number()]) }),
	v.object({ doubleValue: v.number() }),
	v.object({ boolValue: v.boolean() }),
	v.object({ arrayValue: v.unknown() }),
	v.object({ kvlistValue: v.unknown() }),
	v.object({ bytesValue: v.string() }),
]);
export type AnyValue = v.InferOutput<typeof AnyValueSchema>;

const KeyValueSchema = v.object({
	key: v.string(),
	value: v.optional(AnyValueSchema),
});
export type KeyValue = v.InferOutput<typeof KeyValueSchema>;

const ResourceSchema = v.object({
	attributes: v.optional(v.array(KeyValueSchema), []),
});

const InstrumentationScopeSchema = v.object({
	name: v.optional(v.string()),
	version: v.optional(v.string()),
	attributes: v.optional(v.array(KeyValueSchema), []),
});

const SpanSchema = v.object({
	traceId: v.string(),
	spanId: v.string(),
	parentSpanId: v.optional(v.string()),
	name: v.string(),
	// OTLP/JSON encodes nanoseconds-since-epoch as a string. Both ends accepted.
	startTimeUnixNano: v.union([v.string(), v.number()]),
	endTimeUnixNano: v.union([v.string(), v.number()]),
	attributes: v.optional(v.array(KeyValueSchema), []),
});
export type OtlpSpan = v.InferOutput<typeof SpanSchema>;

const ScopeSpansSchema = v.object({
	scope: v.optional(InstrumentationScopeSchema),
	spans: v.optional(v.array(SpanSchema), []),
});

const ResourceSpansSchema = v.object({
	resource: v.optional(ResourceSchema),
	scopeSpans: v.optional(v.array(ScopeSpansSchema), []),
});

export const ExportTraceServiceRequestSchema = v.object({
	resourceSpans: v.optional(v.array(ResourceSpansSchema), []),
});
export type ExportTraceServiceRequest = v.InferOutput<typeof ExportTraceServiceRequestSchema>;

/**
 * OTLP exporters expect a small JSON envelope from a successful export call.
 * Returning `{}` is also accepted; we include `partialSuccess` shape so an
 * exporter that logs it sees a coherent body.
 */
export const ExportTraceServiceResponseSchema = v.object({
	partialSuccess: v.optional(
		v.object({
			rejectedSpans: v.optional(v.number(), 0),
			errorMessage: v.optional(v.string()),
		}),
	),
});
export type ExportTraceServiceResponse = v.InferOutput<typeof ExportTraceServiceResponseSchema>;

export const MAX_OTLP_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_SPANS_PER_REQUEST = 512;
export const MAX_SPANS_PER_REPLAY = 5_000;

export const XRAY_REPLAY_ID_KEY = "xray.replay.id";
export const XRAY_CONVERSATION_ID_KEY = "xray.conversation.id";
export const XRAY_CONVERSATION_VERSION_KEY = "xray.conversation.version";
export const XRAY_TURN_KEY_KEY = "xray.turn.key";
export const XRAY_TURN_IDX_KEY = "xray.turn.idx";
export const XRAY_MODALITY_KEY = "xray.modality";

export interface FlatAttributes {
	[key: string]: string | number | boolean | null;
}

export interface ProjectedSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	startedAt: string;
	endedAt: string;
	attributes: FlatAttributes;
}
