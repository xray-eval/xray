import { describe, expect, it } from "bun:test";

import { diffRunConfigs } from "./run-config-diff.ts";

describe("diffRunConfigs", () => {
	it("flags no cells when both configs are identical", () => {
		const rows = diffRunConfigs([
			{ model: "gpt-4", temperature: 0.2 },
			{ model: "gpt-4", temperature: 0.2 },
		]);

		for (const row of rows) {
			for (const cell of row.cells) {
				expect(cell.differsFromBaseline).toBe(false);
			}
		}
	});

	it("highlights only the differing key when one field differs", () => {
		const rows = diffRunConfigs([
			{ model: "gpt-4", temperature: 0.2 },
			{ model: "gpt-4o", temperature: 0.2 },
		]);

		const modelRow = rows.find((r) => r.key === "model");
		const temperatureRow = rows.find((r) => r.key === "temperature");
		expect(modelRow).toBeDefined();
		expect(temperatureRow).toBeDefined();
		expect(modelRow?.cells[0]?.differsFromBaseline).toBe(false);
		expect(modelRow?.cells[1]?.differsFromBaseline).toBe(true);
		expect(temperatureRow?.cells[0]?.differsFromBaseline).toBe(false);
		expect(temperatureRow?.cells[1]?.differsFromBaseline).toBe(false);
	});

	it("treats a null config as missing on every key; opposite-side cells highlight as differing", () => {
		const rows = diffRunConfigs([null, { model: "gpt-4", temperature: 0.2 }]);

		expect(rows.length).toBe(2);
		for (const row of rows) {
			expect(row.cells[0]?.present).toBe(false);
			expect(row.cells[1]?.present).toBe(true);
			expect(row.cells[1]?.differsFromBaseline).toBe(false);
			expect(row.cells[0]?.differsFromBaseline).toBe(true);
		}
	});

	it("considers a missing key different from a present null", () => {
		const rows = diffRunConfigs([{ flag: null }, {}]);
		const flagRow = rows.find((r) => r.key === "flag");
		expect(flagRow?.cells[0]?.present).toBe(true);
		expect(flagRow?.cells[1]?.present).toBe(false);
		expect(flagRow?.cells[1]?.differsFromBaseline).toBe(true);
	});

	it("collects keys from every input object, sorted", () => {
		const rows = diffRunConfigs([{ b: 1, a: 2 }, { c: 3 }]);
		expect(rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
	});

	it("compares nested values structurally", () => {
		const rows = diffRunConfigs([{ env: { region: "us-east-1" } }, { env: { region: "us-east-1" } }]);
		const envRow = rows.find((r) => r.key === "env");
		expect(envRow?.cells[1]?.differsFromBaseline).toBe(false);
	});

	it("treats an array config as no fields", () => {
		const rows = diffRunConfigs([[1, 2, 3], { model: "gpt-4" }]);
		expect(rows.length).toBe(1);
		expect(rows[0]?.key).toBe("model");
		expect(rows[0]?.cells[0]?.present).toBe(false);
	});
});
