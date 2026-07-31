import { COMPARE_CONFIGS_MAX } from "@/server/run-configs/run-configs.types.ts";

import { accentAt, COLUMN_ACCENTS } from "./column-accents.ts";
import { describe, expect, it } from "bun:test";

describe("accentAt", () => {
	it("gives each of the first five positions its own token", () => {
		const first = [0, 1, 2, 3, 4].map(accentAt);
		expect(new Set(first).size).toBe(COLUMN_ACCENTS.length);
	});

	it("wraps rather than running out, since the cap exceeds the token count", () => {
		// Positions 5..7 are reachable — the comparison cap is 8 and the theme
		// has five chart tokens. Returning undefined here would render a stripe
		// with no background at all.
		for (let i = 0; i < COMPARE_CONFIGS_MAX; i++) {
			expect(accentAt(i)).toBe(COLUMN_ACCENTS[i % COLUMN_ACCENTS.length] ?? "");
		}
		expect(accentAt(5)).toBe(accentAt(0));
	});

	it("never returns an empty class", () => {
		for (let i = 0; i < COMPARE_CONFIGS_MAX; i++) {
			expect(accentAt(i).length).toBeGreaterThan(0);
		}
	});
});
