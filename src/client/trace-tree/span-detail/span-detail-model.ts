import type { SpanResponse } from "@/client/api/api.types.ts";
import { isJsonRecord, safeParseJson } from "@/client/lib/json.ts";

import type {
	AttributeEntry,
	SpanAttributes,
	SpanDetailModel,
	SpanDetailSource,
} from "./span-detail.types.ts";

/** Millisecond gap between two ISO timestamps, clamped to 0 on bad input. */
export function spanDurationMs(startedAt: string, endedAt: string): number {
	const ms = Date.parse(endedAt) - Date.parse(startedAt);
	return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/** Seconds from replay start to `iso`, the offset the waveform/playhead use. */
export function offsetSec(iso: string, replayStartIso: string): number {
	const sec = (Date.parse(iso) - Date.parse(replayStartIso)) / 1_000;
	return Number.isFinite(sec) ? sec : 0;
}

/**
 * Parse `spans.attributes_json` into sorted, namespace-split entries. The
 * stored value is always a flat JSON object in practice, but parse
 * defensively: a malformed string or a non-object top level falls back to a
 * raw view rather than throwing or silently dropping the data.
 */
export function parseSpanAttributes(attributesJson: string): SpanAttributes {
	const parsed = safeParseJson(attributesJson);
	if (!parsed.ok || !isJsonRecord(parsed.value)) {
		return { kind: "raw", raw: attributesJson };
	}
	const entries = Object.entries(parsed.value)
		.map(([key, value]) => toAttributeEntry(key, value))
		.sort((a, b) => a.key.localeCompare(b.key));
	return { kind: "parsed", entries };
}

function toAttributeEntry(key: string, value: unknown): AttributeEntry {
	const dot = key.indexOf(".");
	if (dot === -1) return { key, namespace: "", leaf: key, value };
	return { key, namespace: key.slice(0, dot), leaf: key.slice(dot + 1), value };
}

function resolveParentName(
	parentSpanId: string | null,
	spans: readonly SpanResponse[],
): string | null {
	if (parentSpanId === null) return null;
	return spans.find((s) => s.span_id === parentSpanId)?.name ?? null;
}

/**
 * Assemble the full detail model for the selected span, or `null` when no
 * span is selected / the id doesn't resolve. `model_usage` and `tool_calls`
 * are linked by the OTLP `span_id` (unique per replay), which is exactly how
 * the analyze chain associated them with the span that emitted them.
 */
export function resolveSpanDetail(
	spanId: string | null,
	source: SpanDetailSource,
): SpanDetailModel | null {
	if (spanId === null) return null;
	const span = source.spans.find((s) => s.span_id === spanId);
	if (span === undefined) return null;
	return {
		span,
		durationMs: spanDurationMs(span.started_at, span.ended_at),
		startOffsetSec: offsetSec(span.started_at, source.replayStartIso),
		endOffsetSec: offsetSec(span.ended_at, source.replayStartIso),
		parentName: resolveParentName(span.parent_span_id, source.spans),
		attributes: parseSpanAttributes(span.attributes_json),
		usage: source.modelUsage.filter((u) => u.span_id === spanId),
		toolCalls: source.toolCalls.filter((t) => t.span_id === spanId),
	};
}
