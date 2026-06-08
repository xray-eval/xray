import type { OpenAICompatibleChatJudgeOptions } from "./judges.openai-compatible.ts";
import { createOpenAICompatibleChatJudge } from "./judges.openai-compatible.ts";
import type { JudgeProvider } from "./judges.types.ts";

// Pinned dated snapshot — the floating `mistral-medium-latest` alias gets
// re-pointed across releases, and a moving target on a verdict layer
// produces silent test drift (same transcript passes Tuesday, fails
// Wednesday). Operators who want a different snapshot set XRAY_JUDGE_MODEL.
const DEFAULT_MODEL = "mistral-medium-2604";

export type MistralJudgeOptions = OpenAICompatibleChatJudgeOptions;

/**
 * Mistral Chat Completions judge. Mistral's API is OpenAI-compatible, so
 * this is a thin wrapper over the shared factory pinning only Mistral's
 * url + default model. See `judges.openai-compatible.ts` for the
 * request/parse/error logic.
 */
export function createMistralJudgeProvider(opts: MistralJudgeOptions): JudgeProvider {
	return createOpenAICompatibleChatJudge(
		{
			name: "mistral",
			chatUrl: "https://api.mistral.ai/v1/chat/completions",
			defaultModel: DEFAULT_MODEL,
			credentialEnvVar: "MISTRAL_API_KEY",
		},
		opts,
	);
}
