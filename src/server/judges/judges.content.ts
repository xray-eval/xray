import * as v from "valibot";

import { JudgeOutputParseError } from "./judges.errors.ts";
import type { JudgeProviderResponse } from "./judges.types.ts";

const JudgeContentSchema = v.object({
	score: v.number(),
	reason: v.string(),
});

/**
 * Parse a judge model's textual reply into the `{score: int, reason:
 * string}` contract every provider returns. Shared by all judge back-ends
 * (OpenAI-compatible, Gemini, Bedrock) so the range/rounding rules can't
 * drift between them. Throws `JudgeOutputParseError` tagged with the
 * calling provider's name.
 */
export function parseJudgeContent(provider: string, content: string): JudgeProviderResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new JudgeOutputParseError(provider, content, "content was not valid JSON", {
			cause,
		});
	}
	const result = v.safeParse(JudgeContentSchema, parsed);
	if (!result.success) {
		throw new JudgeOutputParseError(
			provider,
			content,
			`content failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const score = result.output.score;
	if (!Number.isFinite(score)) {
		throw new JudgeOutputParseError(provider, content, "score was not a finite number");
	}
	const intScore = Math.round(score);
	if (intScore < 0 || intScore > 100) {
		throw new JudgeOutputParseError(
			provider,
			content,
			`score ${intScore} outside the 0..100 range`,
		);
	}
	return { score: intScore, reason: result.output.reason };
}
