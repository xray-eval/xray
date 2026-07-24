export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

export function safeParseJson(raw: string): JsonParseResult {
	try {
		const value: unknown = JSON.parse(raw);
		return { ok: true, value };
	} catch {
		return { ok: false };
	}
}

export function isJsonContainer(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
