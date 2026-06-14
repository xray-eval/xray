import type { FlatAttributes } from "../otlp.types.ts";

export function pickPrefixed(attrs: FlatAttributes, prefix: string): FlatAttributes {
	const out: FlatAttributes = {};
	for (const [k, v] of Object.entries(attrs)) {
		if (k.startsWith(prefix)) out[k] = v;
	}
	return out;
}

export function asString(v: FlatAttributes[string] | undefined): string | null {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return null;
}

export function asInteger(v: FlatAttributes[string] | undefined): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "string" && /^[-+]?\d+$/.test(v)) return Number(v);
	return null;
}

/**
 * Parse a finite floating-point value (number, or numeric string incl.
 * decimals). Used for semconv durations expressed in seconds — e.g.
 * `gen_ai.response.time_to_first_chunk` = `0.5`.
 */
export function asFiniteNumber(v: FlatAttributes[string] | undefined): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

export function safeJsonString(maybeJson: string): string {
	try {
		const parsed = JSON.parse(maybeJson);
		return JSON.stringify(parsed);
	} catch {
		return JSON.stringify(maybeJson);
	}
}

export function msBetween(startedAt: string, endedAt: string): number | null {
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	const ms = end - start;
	return ms >= 0 ? ms : null;
}
