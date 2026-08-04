import { CosmosDevError, CosmosImportsTimeoutError, RendererUrlError } from "./dev.errors.ts";
import { describe, expect, test } from "bun:test";

describe("RendererUrlError", () => {
	test("is catchable as a CosmosDevError", () => {
		expect(new RendererUrlError("localhost") instanceof CosmosDevError).toBe(true);
	});

	test("keeps a stable name a minifier cannot mangle", () => {
		expect(new RendererUrlError("localhost").name).toBe("RendererUrlError");
	});

	test("carries the url that could not be parsed", () => {
		const err = new RendererUrlError("http://localhost");
		expect(err.rendererUrl).toBe("http://localhost");
		expect(err.message).toContain("http://localhost");
	});
});

describe("CosmosImportsTimeoutError", () => {
	test("is catchable as a CosmosDevError", () => {
		expect(new CosmosImportsTimeoutError("/tmp/x.ts", 30_000) instanceof CosmosDevError).toBe(true);
	});

	test("keeps a stable name a minifier cannot mangle", () => {
		expect(new CosmosImportsTimeoutError("/tmp/x.ts", 30_000).name).toBe(
			"CosmosImportsTimeoutError",
		);
	});

	test("carries the path it waited on and how long it waited", () => {
		const err = new CosmosImportsTimeoutError("/tmp/cosmos.imports.ts", 30_000);
		expect(err.importsPath).toBe("/tmp/cosmos.imports.ts");
		expect(err.timeoutMs).toBe(30_000);
		// The message has to point at the cosmos output, because the actual cause
		// is always upstream — a config or fixture-scan error we never see here.
		expect(err.message).toContain("cosmos output");
	});
});

describe("CosmosDevError", () => {
	test("is an Error, so an unhandled throw still prints a stack", () => {
		expect(new CosmosDevError("boom") instanceof Error).toBe(true);
		expect(new CosmosDevError("boom").name).toBe("CosmosDevError");
	});
});
