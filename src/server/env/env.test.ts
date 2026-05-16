import { describe, expect, test } from "vitest";

import { InvalidEnvError, loadEnv } from "./env.ts";

describe("loadEnv", () => {
	test("applies defaults when keys are missing", () => {
		expect(loadEnv({})).toEqual({ PORT: 8080, HOST: "0.0.0.0", XRAY_DATA_DIR: "/data" });
	});

	test("parses PORT as integer and keeps HOST and XRAY_DATA_DIR", () => {
		expect(loadEnv({ PORT: "3000", HOST: "127.0.0.1", XRAY_DATA_DIR: "./data" })).toEqual({
			PORT: 3000,
			HOST: "127.0.0.1",
			XRAY_DATA_DIR: "./data",
		});
	});

	test("throws InvalidEnvError on empty XRAY_DATA_DIR", () => {
		expect(() => loadEnv({ XRAY_DATA_DIR: "" })).toThrow(InvalidEnvError);
	});

	test("throws InvalidEnvError on non-numeric PORT", () => {
		expect(() => loadEnv({ PORT: "not-a-number" })).toThrow(InvalidEnvError);
	});

	test("throws InvalidEnvError on out-of-range PORT", () => {
		expect(() => loadEnv({ PORT: "70000" })).toThrow(InvalidEnvError);
	});

	test("InvalidEnvError carries issues", () => {
		try {
			loadEnv({ PORT: "0" });
			expect.unreachable();
		} catch (e) {
			if (!(e instanceof InvalidEnvError)) throw e;
			expect(e.issues.length).toBeGreaterThan(0);
		}
	});
});
