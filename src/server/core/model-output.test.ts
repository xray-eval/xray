import { stripCodeFences } from "./model-output.ts";
import { describe, expect, it } from "bun:test";

describe("stripCodeFences", () => {
	it("returns bare JSON unchanged", () => {
		expect(stripCodeFences('{"score": 80}')).toBe('{"score": 80}');
	});

	it("trims surrounding whitespace", () => {
		expect(stripCodeFences('  {"a": 1}\n')).toBe('{"a": 1}');
	});

	it("unwraps a ```json fence", () => {
		expect(stripCodeFences('```json\n{"score": 80, "reason": "x"}\n```')).toBe(
			'{"score": 80, "reason": "x"}',
		);
	});

	it("unwraps a bare ``` fence", () => {
		expect(stripCodeFences('```\n{"a": 1}\n```')).toBe('{"a": 1}');
	});

	it("unwraps a fence surrounded by whitespace", () => {
		expect(stripCodeFences('\n  ```json\n{"a": 1}\n```  \n')).toBe('{"a": 1}');
	});

	it("leaves inner backticks of non-fenced text untouched", () => {
		expect(stripCodeFences("use `foo` here")).toBe("use `foo` here");
	});

	it("leaves text with only an opening fence untouched", () => {
		expect(stripCodeFences('```json\n{"a": 1}')).toBe('```json\n{"a": 1}');
	});
});
