export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

/**
 * Parse JSON without throwing. The success branch carries `unknown` (not
 * `any`) so callers must narrow before use — see `isJsonContainer` /
 * `isJsonRecord`.
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

/** JSON object excluding arrays — narrows to `Record<string, unknown>` without a cast. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
