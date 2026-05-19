import type { FlatAttributes, ProjectedSpan } from "../otlp.types.ts";

export interface MakeProjectedSpanOptions {
	name?: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string | null;
	startedAt?: string;
	endedAt?: string;
	attributes?: FlatAttributes;
}

let spanCounter = 0;

export function makeProjectedSpan(opts: MakeProjectedSpanOptions = {}): ProjectedSpan {
	spanCounter += 1;
	return {
		traceId: opts.traceId ?? `trace-${spanCounter}`,
		spanId: opts.spanId ?? `span-${spanCounter}`,
		parentSpanId: opts.parentSpanId ?? null,
		name: opts.name ?? "unrecognized.span",
		startedAt: opts.startedAt ?? "2026-05-18T12:00:00.000Z",
		endedAt: opts.endedAt ?? "2026-05-18T12:00:01.000Z",
		attributes: opts.attributes ?? {},
	};
}

export const EMPTY_RESOURCE: FlatAttributes = Object.freeze({});
