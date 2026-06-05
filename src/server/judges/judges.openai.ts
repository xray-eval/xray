import type { OpenAICompatibleChatJudgeOptions } from "./judges.openai-compatible.ts";
import { createOpenAICompatibleChatJudge } from "./judges.openai-compatible.ts";
import type { JudgeProvider } from "./judges.types.ts";

// Pinned model snapshot — the floating alias `gpt-4o` has been re-pointed
// multiple times in the past year, and a moving target on a verdict layer
// produces silent test drift (same transcript passes Tuesday, fails
// Wednesday). Operators who want a different snapshot set XRAY_JUDGE_MODEL.
const DEFAULT_MODEL = "gpt-4o-2024-08-06";

export type OpenAIJudgeOptions = OpenAICompatibleChatJudgeOptions;

/**
 * OpenAI Chat Completions judge. A thin wrapper over the shared
 * OpenAI-compatible factory (OpenAI and Mistral speak the identical
 * contract); this file only pins OpenAI's url + default model. See
 * `judges.openai-compatible.ts` for the request/parse/error logic.
 */
export function createOpenAIJudgeProvider(opts: OpenAIJudgeOptions): JudgeProvider {
	return createOpenAICompatibleChatJudge(
		{
			name: "openai",
			chatUrl: "https://api.openai.com/v1/chat/completions",
			defaultModel: DEFAULT_MODEL,
			credentialEnvVar: "OPENAI_API_KEY",
		},
		opts,
	);
}
