import { canonicalRunConfigJson, hashRunConfig } from "./run-configs.hash.ts";
import { describe, expect, test } from "bun:test";

describe("canonicalRunConfigJson", () => {
	test("sorts object keys so declaration order does not affect identity", () => {
		expect(canonicalRunConfigJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalRunConfigJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
	});

	test("sorts nested object keys too", () => {
		const nested = canonicalRunConfigJson({ outer: { z: 1, a: { y: 2, b: 3 } } });
		expect(nested).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
	});

	test("preserves array order — position is meaning, not a key", () => {
		expect(canonicalRunConfigJson({ tools: ["b", "a"] })).toBe('{"tools":["b","a"]}');
	});

	test("encodes floats — the whole reason this is not the conversation canonicalizer", () => {
		expect(canonicalRunConfigJson({ temperature: 0.5 })).toBe('{"temperature":0.5}');
		expect(canonicalRunConfigJson({ top_p: 0.95 })).toBe('{"top_p":0.95}');
	});

	test("collapses -0 onto 0 so the two spellings share an identity", () => {
		expect(canonicalRunConfigJson({ bias: -0 })).toBe(canonicalRunConfigJson({ bias: 0 }));
	});

	test("encodes null, booleans and unicode strings", () => {
		expect(canonicalRunConfigJson({ a: null, b: true, c: "héllo" })).toBe(
			'{"a":null,"b":true,"c":"héllo"}',
		);
	});

	test("rejects values JSON cannot represent", () => {
		expect(() => canonicalRunConfigJson({ n: Number.NaN })).toThrow(TypeError);
		expect(() => canonicalRunConfigJson({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
		expect(() => canonicalRunConfigJson({ n: 1n })).toThrow(TypeError);
	});
});

describe("hashRunConfig", () => {
	test("returns 64-char lowercase hex", () => {
		const hash = hashRunConfig({ model: "gpt-4o" });
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("key order does not change the hash", () => {
		expect(hashRunConfig({ model: "gpt-4o", temperature: 0.5 })).toBe(
			hashRunConfig({ temperature: 0.5, model: "gpt-4o" }),
		);
	});

	test("different content yields a different hash", () => {
		expect(hashRunConfig({ model: "gpt-4o" })).not.toBe(hashRunConfig({ model: "gpt-4o-mini" }));
	});

	test("1.0 and 1 are the same config — JSON.parse already erased the distinction", () => {
		expect(hashRunConfig({ temperature: 1 })).toBe(
			hashRunConfig(JSON.parse('{"temperature":1.0}')),
		);
	});

	test("hashes non-object configs so a stray scalar still groups deterministically", () => {
		expect(hashRunConfig("gpt-4o")).toMatch(/^[0-9a-f]{64}$/);
		expect(hashRunConfig("gpt-4o")).not.toBe(hashRunConfig({ model: "gpt-4o" }));
	});
});
