/**
 * Shallow field-level diff of N `run_config` blobs (one per replay). Top-level
 * keys only — devs put env vars / model name / flags at the top level, so
 * "what changed between these two runs" is answerable without recursing.
 *
 * Each output row carries a key and an array of N cell values aligned with
 * the input order. A cell is `undefined` when the source object didn't have
 * that key (or the whole config was `null`); the renderer can highlight it
 * differently from a present `null`.
 */
export interface RunConfigDiffCell {
	readonly present: boolean;
	readonly value: unknown;
	readonly differsFromBaseline: boolean;
}

export interface RunConfigDiffRow {
	readonly key: string;
	readonly cells: readonly RunConfigDiffCell[];
}

export function diffRunConfigs(configs: readonly unknown[]): readonly RunConfigDiffRow[] {
	const objects = configs.map(toPlainObject);
	const keys = collectKeys(objects);
	return keys.map((key) => {
		const cells = objects.map((obj) => buildCell(obj, key));
		const baseline = firstPresent(cells);
		return {
			key,
			cells: cells.map((cell) => ({
				...cell,
				differsFromBaseline: baseline === undefined ? false : !cellsMatch(cell, baseline),
			})),
		};
	});
}

function toPlainObject(config: unknown): Record<string, unknown> | null {
	if (!isPlainObject(config)) return null;
	return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectKeys(objects: readonly (Record<string, unknown> | null)[]): string[] {
	const set = new Set<string>();
	for (const obj of objects) {
		if (obj === null) continue;
		for (const key of Object.keys(obj)) set.add(key);
	}
	return [...set].sort();
}

function buildCell(
	obj: Record<string, unknown> | null,
	key: string,
): { present: boolean; value: unknown } {
	if (obj === null || !Object.hasOwn(obj, key)) return { present: false, value: undefined };
	return { present: true, value: obj[key] };
}

function firstPresent(
	cells: readonly { present: boolean; value: unknown }[],
): { present: boolean; value: unknown } | undefined {
	return cells.find((c) => c.present);
}

function cellsMatch(
	a: { present: boolean; value: unknown },
	b: { present: boolean; value: unknown },
): boolean {
	if (a.present !== b.present) return false;
	if (!a.present) return true;
	return jsonEqual(a.value, b.value);
}

function jsonEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	return JSON.stringify(a) === JSON.stringify(b);
}
