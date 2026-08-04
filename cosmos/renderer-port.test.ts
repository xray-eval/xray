import config from "../cosmos.config.json";
import { RendererUrlError } from "./dev.errors.ts";
import { rendererPort } from "./renderer-port.ts";
import { describe, expect, test } from "bun:test";

describe("rendererPort", () => {
	test("reads the port Cosmos will load the renderer from", () => {
		expect(rendererPort("http://localhost:5051")).toBe(5051);
	});

	test("the committed config carries a port, so the workbench starts", () => {
		// The one input that actually ships. A `rendererUrl` edited to drop its
		// port would fail at `pnpm cosmos` with the iframe pointing nowhere.
		expect(rendererPort(config.rendererUrl)).toBeGreaterThan(0);
	});

	test("rejects a URL with no explicit port rather than guessing one", () => {
		// Defaulting to 80 would serve the renderer where Cosmos isn't looking.
		expect(() => rendererPort("http://localhost")).toThrow(RendererUrlError);
	});

	test("rejects a relative URL, which can carry no port at all", () => {
		expect(() => rendererPort("/renderer")).toThrow(RendererUrlError);
	});

	test("names the offending url on the error, since it comes from a config file", () => {
		try {
			rendererPort("http://localhost");
			throw new Error("expected rendererPort to throw");
		} catch (err) {
			if (!(err instanceof RendererUrlError)) throw err;
			expect(err.rendererUrl).toBe("http://localhost");
		}
	});
});
