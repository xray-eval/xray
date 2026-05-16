import { DuplicateAdapterError } from "./errors/errors.ts";
import { createRegistry } from "./registry.ts";
import { makeFakeAdapter } from "./test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("createRegistry", () => {
	it("retrieves an adapter by provider after registration", () => {
		const registry = createRegistry();
		const adapter = makeFakeAdapter("elevenlabs");
		registry.register(adapter);
		expect(registry.get("elevenlabs")).toBe(adapter);
	});

	it("returns undefined for an unregistered provider", () => {
		const registry = createRegistry();
		expect(registry.get("vapi")).toBeUndefined();
	});

	it("throws DuplicateAdapterError on double registration of the same provider", () => {
		const registry = createRegistry();
		registry.register(makeFakeAdapter("elevenlabs"));
		expect(() => registry.register(makeFakeAdapter("elevenlabs"))).toThrow(DuplicateAdapterError);
	});

	it("lists every registered adapter in registration order", () => {
		const registry = createRegistry();
		const a = makeFakeAdapter("elevenlabs");
		const b = makeFakeAdapter("vapi");
		registry.register(a);
		registry.register(b);
		expect(registry.list()).toEqual([a, b]);
	});

	it("isolates state across instances — separate registries do not share adapters", () => {
		const r1 = createRegistry();
		const r2 = createRegistry();
		r1.register(makeFakeAdapter("elevenlabs"));
		expect(r2.get("elevenlabs")).toBeUndefined();
	});
});
