import { extractJsonObject } from "./model-output.ts";
import { describe, expect, it } from "bun:test";

describe("extractJsonObject", () => {
	// The shapes a judge model actually replies with. Table-driven so a
	// regression names the shape that broke rather than a loop index.
	it.each([
		["returns bare JSON unchanged", '{"score": 80}', '{"score": 80}'],
		[
			"returns bare multi-key JSON unchanged",
			'{"score": 80, "reason": "x"}',
			'{"score": 80, "reason": "x"}',
		],
		[
			"unwraps a ```json fence",
			'```json\n{"score": 80, "reason": "x"}\n```',
			'{"score": 80, "reason": "x"}',
		],
		[
			"drops a preamble before a fenced block",
			'Here is my verdict:\n```json\n{"score": 80, "reason": "x"}\n```',
			'{"score": 80, "reason": "x"}',
		],
		[
			"drops a trailer after a fenced block",
			'```json\n{"score": 80, "reason": "x"}\n```\nhope this helps',
			'{"score": 80, "reason": "x"}',
		],
		[
			"extracts JSON that follows inline prose",
			'My verdict: {"score": 80, "reason": "x"}',
			'{"score": 80, "reason": "x"}',
		],
		[
			"keeps a nested object intact via the last closing brace",
			'prefix {"score": 80, "meta": {"k": 1}} suffix',
			'{"score": 80, "meta": {"k": 1}}',
		],
		["returns the trimmed input when there is no object", "  no json here  ", "no json here"],
	])("%s", (_label, input, expected) => {
		expect(extractJsonObject(input)).toBe(expected);
	});
});
