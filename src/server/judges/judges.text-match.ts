import type { TurnRole } from "@/server/store/types.ts";

import type { JudgeOutcome, JudgeProvider } from "./judges.types.ts";

const SYSTEM_PROMPT = `You are an evaluator scoring a voice agent's behavior against a reference description.

Reply with a single JSON object: {"score": <integer 0..100>, "reason": "<one sentence explanation>"}.
- 100 means the transcript fully matches the reference behavior.
- 0 means the transcript completely fails to match.
- Be strict but fair: partial matches get partial credit.
- The "reason" must cite specific transcript content, not generic praise.`;

export interface TextMatchJudgeInput {
	readonly reference: string;
	readonly rubric: string | null;
	readonly passScore: number;
}

export interface JudgeTranscriptTurn {
	readonly turnIdx: number;
	readonly role: TurnRole;
	readonly text: string;
}

/**
 * Run a `text_match` judge: build the prompt from the reference + optional
 * rubric + full transcript, call the provider, and map the 0..100 score to
 * pass/fail using `passScore`. Errors from the provider bubble up as
 * `JudgeError` subclasses; the evaluate-replay processor catches and
 * stamps `status: "errored"`.
 */
export async function runTextMatchJudge(
	input: TextMatchJudgeInput,
	turns: readonly JudgeTranscriptTurn[],
	provider: JudgeProvider,
): Promise<JudgeOutcome> {
	const userPrompt = buildUserPrompt(input, turns);
	const { score, reason } = await provider.judge({
		systemPrompt: SYSTEM_PROMPT,
		userPrompt,
	});
	return {
		status: score >= input.passScore ? "passed" : "failed",
		score,
		reason,
		provider: provider.name,
		model: provider.model,
	};
}

/**
 * Concatenate the per-turn transcripts in turn order with role prefixes.
 * `[user]` / `[agent]` rather than a stage-direction style — keeps the
 * prompt token count low without losing speaker attribution.
 */
export function buildUserPrompt(
	input: TextMatchJudgeInput,
	turns: readonly JudgeTranscriptTurn[],
): string {
	const sorted = [...turns].sort((a, b) => a.turnIdx - b.turnIdx);
	const transcriptBlock = sorted
		.map((t) => `[turn ${t.turnIdx}] [${t.role}]: ${t.text}`)
		.join("\n");
	const rubricBlock =
		input.rubric !== null && input.rubric.length > 0
			? `\nAdditional rubric:\n${input.rubric}\n`
			: "";
	return [
		`Reference behavior:\n${input.reference}\n`,
		rubricBlock,
		`Transcript:\n${transcriptBlock.length > 0 ? transcriptBlock : "(empty)"}`,
	].join("\n");
}
