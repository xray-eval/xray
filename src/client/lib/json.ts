export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

/**
 * Parse a JSON string without throwing. The success branch carries `unknown`
 * (not `any`) so callers must narrow before use — see `isJsonContainer` /
 * `isJsonRecord`. Used wherever the wire hands us an opaque JSON string
 * (tool args/results, span attribute bags, run config).
 */
export function safeParseJson(raw: string): JsonParseResult {
	try {
		const value: unknown = JSON.parse(raw);
		return { ok: true, value };
	} catch {
		return { ok: false };
	}
}

/** Object or array — the two shapes `react-json-view-lite` can render. */
export function isJsonContainer(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/**
 * A key-value JSON object, excluding arrays. Narrows to `Record<string,
 * unknown>` via a type predicate (no cast) so the entries can be walked
 * with `Object.entries` and each value stays `unknown`.
 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
