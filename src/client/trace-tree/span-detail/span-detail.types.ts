import type { ModelUsageResponse, SpanResponse, ToolCallResponse } from "@/client/api/api.types.ts";

/**
 * One entry of a span's flattened attribute bag. `key` is the full
 * dotted attribute name; `namespace`/`leaf` split it at the first dot so
 * the UI can dim the shared prefix (e.g. `gen_ai.`) and emphasise the leaf.
 * `value` is the parsed JSON value, left `unknown` so the renderer narrows
 * it (string / number / boolean / null / container) at the point of use.
 */
export type AttributeEntry = Readonly<{
	key: string;
	namespace: string;
	leaf: string;
	value: unknown;
}>;

/**
 * The parsed `spans.attributes_json`. `raw` is the fallback when the string
 * isn't a JSON object — the panel shows the original text rather than
 * pretending the bag was empty.
 */
export type SpanAttributes =
	| Readonly<{ kind: "parsed"; entries: readonly AttributeEntry[] }>
	| Readonly<{ kind: "raw"; raw: string }>;

/**
 * Everything the inspector knows about one span, assembled from the wire
 * response: the span row itself, its precise duration, the name of its
 * parent span (resolved within the same replay), the parsed attribute bag,
 * and the `model_usage` / `tool_calls` rows the analyze chain linked to it
 * by `span_id`.
 */
export type SpanDetailModel = Readonly<{
	span: SpanResponse;
	durationMs: number;
	startOffsetSec: number;
	endOffsetSec: number;
	parentName: string | null;
	attributes: SpanAttributes;
	usage: readonly ModelUsageResponse[];
	toolCalls: readonly ToolCallResponse[];
}>;

/**
 * The slices of a `ReplayDetailResponse` needed to resolve a span detail.
 * `replayStartIso` lets the panel show start/end as a clock offset from
 * replay start — the same reading the waveform and the trace playhead use.
 */
export type SpanDetailSource = Readonly<{
	replayStartIso: string;
	spans: readonly SpanResponse[];
	modelUsage: readonly ModelUsageResponse[];
	toolCalls: readonly ToolCallResponse[];
}>;
