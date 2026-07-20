import { parseJudgeContent } from "./judges.content.ts";
import { JudgeOutputParseError } from "./judges.errors.ts";
import { describe, expect, it } from "bun:test";

describe("parseJudgeContent", () => {
	it("parses a valid {score, reason} payload", () => {
		const out = parseJudgeContent("p", '{"score": 80, "reason": "matches"}');
		expect(out.score).toBe(80);
		expect(out.reason).toBe("matches");
	});

	it("rounds non-integer scores to the nearest integer", () => {
		expect(parseJudgeContent("p", '{"score": 87.6, "reason": "x"}').score).toBe(88);
	});

	it("throws JudgeOutputParseError tagged with the provider on non-JSON content", () => {
		const err = (() => {
			try {
				parseJudgeContent("bedrock", "not json");
				return null;
			} catch (e) {
				return e;
			}
		})();
		if (!(err instanceof JudgeOutputParseError)) {
			throw new Error(`expected JudgeOutputParseError, got ${err}`);
		}
		expect(err.provider).toBe("bedrock");
		expect(err.rawBody).toBe("not json");
	});

	it("throws JudgeOutputParseError when score is outside 0..100", () => {
		expect(() => parseJudgeContent("p", '{"score": 150, "reason": "x"}')).toThrow(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when score is not finite", () => {
		// JSON.parse("1e999") yields Infinity — a valid JSON number that must
		// still be rejected before Math.round produces garbage.
		expect(() => parseJudgeContent("p", '{"score": 1e999, "reason": "x"}')).toThrow(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when reason is missing", () => {
		expect(() => parseJudgeContent("p", '{"score": 50}')).toThrow(JudgeOutputParseError);
	});
});
