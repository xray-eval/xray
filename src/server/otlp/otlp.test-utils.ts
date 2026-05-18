import type { ExportTraceServiceRequest, KeyValue } from "./otlp.types.ts";

/**
 * Build an OTLP/JSON request with one ResourceSpans, one ScopeSpans, and an
 * arbitrary set of spans. Resource attributes default to a single
 * `xray.replay.id` so the receiver routes the spans somewhere by default;
 * tests that want to exercise the drop-on-missing path override `resource`.
 */
export interface MakeOtlpSpanOptions {
	name: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	startedAtMs?: number;
	endedAtMs?: number;
	attributes?: Record<string, string | number | boolean>;
}

export interface MakeOtlpRequestOptions {
	replayId?: string | null;
	resource?: Record<string, string | number | boolean>;
	spans: MakeOtlpSpanOptions[];
}

let spanCounter = 0;
let traceCounter = 0;

export function makeOtlpRequest(opts: MakeOtlpRequestOptions): ExportTraceServiceRequest {
	const resourceAttrs: Record<string, string | number | boolean> = { ...(opts.resource ?? {}) };
	if (opts.replayId !== null) {
		resourceAttrs["xray.replay.id"] = opts.replayId ?? "00000000-0000-0000-0000-000000000001";
	} else {
		delete resourceAttrs["xray.replay.id"];
	}
	traceCounter += 1;
	const traceId = `t${String(traceCounter).padStart(31, "0")}`;
	return {
		resourceSpans: [
			{
				resource: {
					attributes: toKvList(resourceAttrs),
				},
				scopeSpans: [
					{
						scope: { name: "test", attributes: [] },
						spans: opts.spans.map((s) => {
							spanCounter += 1;
							const startMs = s.startedAtMs ?? 1747584000000 + spanCounter;
							const endMs = s.endedAtMs ?? startMs + 1;
							return {
								traceId: s.traceId ?? traceId,
								spanId: s.spanId ?? `s${String(spanCounter).padStart(15, "0")}`,
								...(s.parentSpanId !== undefined ? { parentSpanId: s.parentSpanId } : {}),
								name: s.name,
								startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
								endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
								attributes: toKvList(s.attributes ?? {}),
							};
						}),
					},
				],
			},
		],
	};
}

function toKvList(attrs: Record<string, string | number | boolean>): KeyValue[] {
	return Object.entries(attrs).map(([key, value]) => ({
		key,
		value:
			typeof value === "string"
				? { stringValue: value }
				: typeof value === "boolean"
					? { boolValue: value }
					: Number.isInteger(value)
						? { intValue: String(value) }
						: { doubleValue: value },
	}));
}
