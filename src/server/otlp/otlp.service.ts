import { count, eq } from "drizzle-orm";

import { replayExists } from "@/server/replays/replays.service.ts";
import { modelUsage, spans, toolCalls } from "@/server/store/schema.ts";
import type { Store, StoreDb } from "@/server/store/store.ts";

import { TooManySpansPerRequestError } from "./otlp.errors.ts";
import type {
	AnyValue,
	ExportTraceServiceRequest,
	ExportTraceServiceResponse,
	FlatAttributes,
	KeyValue,
	OtlpSpan,
	ProjectedSpan,
} from "./otlp.types.ts";
import { MAX_SPANS_PER_REPLAY, MAX_SPANS_PER_REQUEST, XRAY_REPLAY_ID_KEY } from "./otlp.types.ts";
import { SPAN_VOCABULARIES } from "./vocabularies/registry.ts";
import type { VocabularyExtraction } from "./vocabularies/vocabularies.types.ts";

export interface IngestOtlpResult {
	rejectedSpans: number;
	persistedSpans: number;
}

/**
 * Filter, not gate. Walk the spans in the request, project them, route by
 * `xray.replay.id`, run each through the vocabulary registry, persist the
 * extracted rows + the raw span row. Anything we don't recognize (no
 * vocab, no replay_id, unknown replay_id) is dropped silently — that's
 * the design point: a dev drops xray in front of an already-instrumented
 * agent and it lights up.
 *
 * Per-request limits are enforced *before* persistence. Spans that would
 * push a replay past `MAX_SPANS_PER_REPLAY` are counted into the OTLP
 * response's `partialSuccess.rejectedSpans` instead of throwing — that way
 * one runaway turn doesn't roll back the under-cap spans that arrived
 * alongside it in the same batch. The persist + cap-counter increment run
 * in a single transaction so concurrent batches for the same replay can't
 * both read a stale count and silently overshoot the cap.
 */
export function ingestOtlpTraces(
	store: Store,
	req: ExportTraceServiceRequest,
): { response: ExportTraceServiceResponse; result: IngestOtlpResult } {
	const projected = projectRequest(req);
	if (projected.length > MAX_SPANS_PER_REQUEST) {
		throw new TooManySpansPerRequestError(MAX_SPANS_PER_REQUEST, projected.length);
	}

	let rejected = 0;
	let persisted = 0;

	store.db.transaction((tx) => {
		// Per-replay counts are read fresh under the transaction's lock so
		// two concurrent OTLP requests for the same replayId serialize on
		// the SQLite writer rather than racing on a per-request in-memory
		// counter.
		const replayCounts = new Map<string, number>();
		for (const { span, resource } of projected) {
			const replayId = resourceReplayId(resource, span.attributes);
			if (replayId === null) {
				rejected += 1;
				continue;
			}
			if (!replayExists(store, replayId)) {
				rejected += 1;
				continue;
			}
			const extraction = recognize(span, resource);
			if (extraction === null) {
				rejected += 1;
				continue;
			}

			if (!replayCounts.has(replayId)) {
				const existing = tx
					.select({ n: count() })
					.from(spans)
					.where(eq(spans.replayId, replayId))
					.get();
				replayCounts.set(replayId, existing?.n ?? 0);
			}
			const current = replayCounts.get(replayId) ?? 0;
			if (current >= MAX_SPANS_PER_REPLAY) {
				// Cap reached for this replay — drop the excess into the
				// OTLP partialSuccess response, persist the in-cap spans
				// the batch already wrote. No rollback.
				rejected += 1;
				continue;
			}

			const insertedRows = tx
				.insert(spans)
				.values({
					replayId,
					traceId: span.traceId,
					spanId: span.spanId,
					parentSpanId: span.parentSpanId,
					name: span.name,
					vocabulary: extraction.vocabulary,
					startedAt: span.startedAt,
					endedAt: span.endedAt,
					attributesJson: JSON.stringify(extraction.attributes),
				})
				.onConflictDoNothing()
				.returning({ id: spans.id })
				.all();

			if (insertedRows.length === 0) {
				// Span already existed (`(traceId, spanId)` conflict). Don't
				// count it against the cap and don't double-process the
				// vocabulary's extracted rows.
				continue;
			}

			replayCounts.set(replayId, current + 1);
			persistExtracted(tx, replayId, span, extraction);
			persisted += 1;
		}
	});

	return {
		response: { partialSuccess: { rejectedSpans: rejected } },
		result: { rejectedSpans: rejected, persistedSpans: persisted },
	};
}

function persistExtracted(
	tx: StoreDb,
	replayId: string,
	span: ProjectedSpan,
	extraction: VocabularyExtraction,
): void {
	if (extraction.toolCalls && extraction.toolCalls.length > 0) {
		tx.insert(toolCalls)
			.values(
				extraction.toolCalls.map((tc) => ({
					replayId,
					turnIdx: turnIdxFromAttributes(span.attributes),
					spanId: span.spanId,
					name: tc.name,
					argsJson: tc.argsJson,
					resultJson: tc.resultJson,
					startedAt: tc.startedAt,
					endedAt: tc.endedAt,
					latencyMs: tc.latencyMs,
				})),
			)
			.run();
	}
	if (extraction.modelUsage && extraction.modelUsage.length > 0) {
		tx.insert(modelUsage)
			.values(
				extraction.modelUsage.map((mu) => ({
					replayId,
					turnIdx: turnIdxFromAttributes(span.attributes),
					spanId: span.spanId,
					provider: mu.provider,
					model: mu.model,
					inputTokens: mu.inputTokens,
					outputTokens: mu.outputTokens,
					totalTokens: mu.totalTokens,
					startedAt: mu.startedAt,
					endedAt: mu.endedAt,
					latencyMs: mu.latencyMs,
				})),
			)
			.run();
	}
}

function recognize(span: ProjectedSpan, resource: FlatAttributes): VocabularyExtraction | null {
	for (const matcher of SPAN_VOCABULARIES) {
		const result = matcher(span, resource);
		if (result !== null) return result;
	}
	return null;
}

function resourceReplayId(resource: FlatAttributes, spanAttrs: FlatAttributes): string | null {
	// span attrs override resource attrs for the per-replay routing key, so
	// an agent that propagates the value via OTEL baggage on a per-call basis
	// still works.
	const fromSpan = asNonEmptyString(spanAttrs[XRAY_REPLAY_ID_KEY]);
	if (fromSpan !== null) return fromSpan;
	return asNonEmptyString(resource[XRAY_REPLAY_ID_KEY]);
}

function turnIdxFromAttributes(attrs: FlatAttributes): number | null {
	const v = attrs["xray.turn.idx"];
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "string" && /^[-+]?\d+$/.test(v)) return Number(v);
	return null;
}

interface ProjectedRequest {
	span: ProjectedSpan;
	resource: FlatAttributes;
}

export function projectRequest(req: ExportTraceServiceRequest): ProjectedRequest[] {
	const out: ProjectedRequest[] = [];
	for (const rs of req.resourceSpans ?? []) {
		const resource = flattenAttributes(rs.resource?.attributes ?? []);
		for (const ss of rs.scopeSpans ?? []) {
			for (const span of ss.spans ?? []) {
				out.push({ span: projectSpan(span), resource });
			}
		}
	}
	return out;
}

function projectSpan(span: OtlpSpan): ProjectedSpan {
	return {
		traceId: span.traceId,
		spanId: span.spanId,
		parentSpanId: span.parentSpanId ?? null,
		name: span.name,
		startedAt: unixNanoToIso(span.startTimeUnixNano),
		endedAt: unixNanoToIso(span.endTimeUnixNano),
		attributes: flattenAttributes(span.attributes ?? []),
	};
}

function flattenAttributes(kvs: readonly KeyValue[]): FlatAttributes {
	const out: FlatAttributes = {};
	for (const kv of kvs) {
		const v = anyValueToPrimitive(kv.value);
		if (v !== undefined) out[kv.key] = v;
	}
	return out;
}

function anyValueToPrimitive(v: AnyValue | undefined): FlatAttributes[string] | undefined {
	if (v === undefined) return undefined;
	if ("stringValue" in v) return v.stringValue;
	if ("intValue" in v) return typeof v.intValue === "string" ? Number(v.intValue) : v.intValue;
	if ("doubleValue" in v) return v.doubleValue;
	if ("boolValue" in v) return v.boolValue;
	// arrayValue / kvlistValue / bytesValue — not flattenable to a primitive,
	// so we serialize them as JSON for the attribute bag. Tests don't rely on
	// inspecting nested arrays today; preserving the shape on disk is enough.
	if ("arrayValue" in v) return JSON.stringify(v.arrayValue);
	if ("kvlistValue" in v) return JSON.stringify(v.kvlistValue);
	if ("bytesValue" in v) return v.bytesValue;
	return undefined;
}

function unixNanoToIso(nano: string | number): string {
	const ns = typeof nano === "string" ? BigInt(nano) : BigInt(Math.trunc(nano));
	const ms = Number(ns / 1_000_000n);
	return new Date(ms).toISOString();
}

function asNonEmptyString(v: FlatAttributes[string] | undefined): string | null {
	if (typeof v !== "string") return null;
	return v.length > 0 ? v : null;
}
