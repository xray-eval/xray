import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";
import type { FetchLike } from "@/server/transcription/transcription.openai-whisper.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import type { JudgeProvider, JudgeProviderResponse } from "./judges.types.ts";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";

export interface OpenAIJudgeOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
}

/**
 * OpenAI Chat Completions judge. Forces `response_format: json_object`
 * and parses the model's reply as `{ score: int, reason: string }`. The
 * variant-level runner (e.g. text-match) decides the system + user
 * prompts; this layer is variant-agnostic.
 *
 * Why a separate provider abstraction (vs. inlining the fetch in each
 * judge variant): different judge variants share the same model + auth
 * + JSON-mode parsing. Swapping the provider (Anthropic, local llm) is
 * one file; swapping it per-variant would multiply the work.
 */
export function createOpenAIJudgeProvider(opts: OpenAIJudgeOptions): JudgeProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	return {
		name: "openai",
		model,
		async judge(input): Promise<JudgeProviderResponse> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("OPENAI_API_KEY");
			}
			const body = {
				model,
				temperature: 0,
				response_format: { type: "json_object" as const },
				messages: [
					{ role: "system", content: input.systemPrompt },
					{ role: "user", content: input.userPrompt },
				],
			};

			let response: Response;
			try {
				response = await fetchImpl(OPENAI_CHAT_URL, {
					method: "POST",
					headers: {
						authorization: `Bearer ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				});
			} catch (cause) {
				throw new JudgeProviderError("openai", "fetch failed", null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new JudgeProviderError(
					"openai",
					`HTTP ${response.status}: ${detail.slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new JudgeProviderError(
					"openai",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}
			const content = extractMessageContent(raw);
			return parseJudgeContent(content);
		},
	};
}

interface ChatCompletionsRaw {
	choices?: unknown;
}

interface ChatCompletionsChoice {
	message?: unknown;
}

interface ChatCompletionsMessage {
	content?: unknown;
}

interface JudgeContentRaw {
	score?: unknown;
	reason?: unknown;
}

function extractMessageContent(raw: unknown): string {
	if (!isObject<ChatCompletionsRaw>(raw)) {
		throw new JudgeProviderError("openai", "response body was not an object");
	}
	const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
	if (!isObject<ChatCompletionsChoice>(choice)) {
		throw new JudgeProviderError("openai", "response missing choices[0].message.content");
	}
	if (!isObject<ChatCompletionsMessage>(choice.message)) {
		throw new JudgeProviderError("openai", "response missing choices[0].message.content");
	}
	const content = choice.message.content;
	if (typeof content !== "string") {
		throw new JudgeProviderError("openai", "response missing choices[0].message.content");
	}
	return content;
}

function parseJudgeContent(content: string): JudgeProviderResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new JudgeOutputParseError("openai", content, "content was not valid JSON", {
			cause,
		});
	}
	if (!isObject<JudgeContentRaw>(parsed)) {
		throw new JudgeOutputParseError("openai", content, "content was not a JSON object");
	}
	const score = parsed.score;
	const reason = parsed.reason;
	if (typeof score !== "number" || !Number.isFinite(score)) {
		throw new JudgeOutputParseError("openai", content, "missing or non-numeric `score`");
	}
	const intScore = Math.round(score);
	if (intScore < 0 || intScore > 100) {
		throw new JudgeOutputParseError(
			"openai",
			content,
			`score ${intScore} outside the 0..100 range`,
		);
	}
	if (typeof reason !== "string") {
		throw new JudgeOutputParseError("openai", content, "missing or non-string `reason`");
	}
	return { score: intScore, reason };
}

/**
 * Narrow `unknown` to an interface-shaped object. The interface is open
 * (every field declared as `unknown?`) so the caller can read individual
 * fields without bracket-key access — works with the strict-mode
 * `noPropertyAccessFromIndexSignature` while keeping biome's
 * `useLiteralKeys` happy.
 */
function isObject<T>(value: unknown): value is T {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
