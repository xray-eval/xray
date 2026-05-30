import { vocabLabel, vocabPalette, vocabShortLabel } from "./vocab.ts";
import { describe, expect, it } from "bun:test";

describe("vocabShortLabel", () => {
	it("maps each vocabulary to its two-char indicator", () => {
		expect(vocabShortLabel("xray")).toBe("xr");
		expect(vocabShortLabel("gen_ai")).toBe("ga");
		expect(vocabShortLabel("langfuse")).toBe("lf");
	});
});

describe("vocabLabel", () => {
	it("maps each vocabulary to its display name", () => {
		expect(vocabLabel("xray")).toBe("xray");
		expect(vocabLabel("gen_ai")).toBe("GenAI");
		expect(vocabLabel("langfuse")).toBe("Langfuse");
	});
});

describe("vocabPalette", () => {
	it("gives each vocabulary a distinct accent outline", () => {
		const outlines = new Set([
			vocabPalette("xray").barOutline,
			vocabPalette("gen_ai").barOutline,
			vocabPalette("langfuse").barOutline,
		]);
		expect(outlines.size).toBe(3);
	});

	it("exposes the four palette slots a row and the detail panel both read", () => {
		const p = vocabPalette("gen_ai");
		expect(p.dotBg).toContain("violet");
		expect(p.text).toContain("violet");
		expect(p.barFill).toContain("167 139 250");
		expect(p.barOutline).toBe("rgb(167 139 250)");
	});
});
