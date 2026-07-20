import { extractJsonObject } from "./model-output.ts";
import { describe, expect, it } from "bun:test";

describe("extractJsonObject", () => {
	it("returns bare JSON unchanged", () => {
		expect(extractJsonObject('{"score": 80}')).toBe('{"score": 80}');
	});

	it("unwraps a ```json fence", () => {
		expect(extractJsonObject('```json\n{"score": 80, "reason": "x"}\n```')).toBe(
			'{"score": 80, "reason": "x"}',
		);
	});

	it("drops a preamble before a fenced block", () => {
		expect(
			extractJsonObject('Here is my verdict:\n```json\n{"score": 80, "reason": "x"}\n```'),
		).toBe('{"score": 80, "reason": "x"}');
	});

	it("drops a trailer after a fenced block", () => {
		expect(extractJsonObject('```json\n{"score": 80, "reason": "x"}\n```\nhope this helps')).toBe(
			'{"score": 80, "reason": "x"}',
		);
	});

	it("extracts JSON that follows inline prose", () => {
		expect(extractJsonObject('My verdict: {"score": 80, "reason": "x"}')).toBe(
			'{"score": 80, "reason": "x"}',
		);
	});

	it("keeps a nested object intact via the last closing brace", () => {
		expect(extractJsonObject('prefix {"score": 80, "meta": {"k": 1}} suffix')).toBe(
			'{"score": 80, "meta": {"k": 1}}',
		);
	});

	it("returns the trimmed input when there is no object", () => {
		expect(extractJsonObject("  no json here  ")).toBe("no json here");
	});

	it("all realistic judge-reply shapes round-trip through JSON.parse", () => {
		const payload = { score: 80, reason: "x" };
		const shapes = [
			'{"score": 80, "reason": "x"}',
			'```json\n{"score": 80, "reason": "x"}\n```',
			'Here is my verdict:\n```json\n{"score": 80, "reason": "x"}\n```',
			'```json\n{"score": 80, "reason": "x"}\n```\nhope this helps',
			'My verdict: {"score": 80, "reason": "x"}',
		];
		for (const shape of shapes) {
			expect(JSON.parse(extractJsonObject(shape))).toEqual(payload);
		}
	});
});
