import * as v from "valibot";

export const MAX_JUDGE_REFERENCE = 8192;
export const MAX_JUDGE_RUBRIC = 2048;
export const MAX_JUDGES = 8;

const TextMatchJudgeSchema = v.object({
	kind: v.literal("text_match"),
	// Natural-language description of the behavior the agent should exhibit; the
	// LLM judge scores the rendered conversation against it. Because the render
	// carries per-turn evidence as well as speech, a reference may describe what
	// the agent DID (tool calls, latency), not only what it said.
	reference: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_JUDGE_REFERENCE)),
	rubric: v.optional(v.pipe(v.string(), v.maxLength(MAX_JUDGE_RUBRIC))),
	// Threshold on the 0..100 score the judge returns: score >= pass_score →
	// "passed", below → "failed". Default 70, a reasonable mid-bar.
	pass_score: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)), 70),
});

/**
 * Conversation-level judge. Runs once per replay against every turn of the
 * replay — walked from `replay_turns`, so a turn whose transcription failed
 * still appears — each rendered with a role prefix and followed by that turn's
 * tool / model / timing evidence. See `judges.evidence.ts` for the projection
 * and the caps.
 */
export const JudgeSchema = v.variant("kind", [TextMatchJudgeSchema]);
export type Judge = v.InferOutput<typeof JudgeSchema>;
export type JudgeKind = Judge["kind"];

export const JudgesArraySchema = v.pipe(v.array(JudgeSchema), v.maxLength(MAX_JUDGES));

export interface JudgeOutcome {
	readonly status: "passed" | "failed" | "errored";
	readonly score: number | null;
	readonly reason: string | null;
	readonly provider: string;
	readonly model: string;
}

/**
 * The provider-shaped output the judge runner asks for — a generic 0..100
 * score, variant-independent. Each judge variant maps it to its own pass/fail.
 */
export interface JudgeProviderResponse {
	readonly score: number;
	readonly reason: string;
}

export interface JudgeProvider {
	readonly name: string;
	readonly model: string;
	judge(input: { systemPrompt: string; userPrompt: string }): Promise<JudgeProviderResponse>;
}
