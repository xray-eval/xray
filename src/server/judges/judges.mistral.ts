import * as v from "valibot";

import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import type { JudgeProvider, JudgeProviderResponse } from "./judges.types.ts";

const MISTRAL_CHAT_URL = "https://api.mistral.ai/v1/chat/completions";
// Pinned dated snapshot — the floating `mistral-medium-latest` alias gets
// re-pointed across releases, and a moving target on a verdict layer
// produces silent test drift (same transcript passes Tuesday, fails
// Wednesday). Operators who want a different snapshot set XRAY_JUDGE_MODEL.
const DEFAULT_MODEL = "mistral-medium-2604";
const DEFAULT_TIMEOUT_MS = 60_000;

// Validate the Mistral Chat Completions response at the boundary per
// `.claude/rules/boundary-validation.md`. Mistral's response is
// OpenAI-shaped; we model only the path we read:
// `choices[0].message.content` is a JSON string (because we forced
// `response_format: json_object` on the request) that itself decodes to
// `{score: int, reason: string}`.
const ChatCompletionsResponseSchema = v.object({
	choices: v.array(
		v.object({
			message: v.object({
				content: v.string(),
			}),
		}),
	),
});
const JudgeContentSchema = v.object({
	score: v.number(),
	reason: v.string(),
});

export interface MistralJudgeOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Mistral Chat Completions judge. Forces `response_format: json_object`
 * and parses the model's reply as `{ score: int, reason: string }`.
 * Variant-agnostic — same contract as `judges.openai.ts`, the variant
 * runner (e.g. text_match) owns the prompt design.
 */
export function createMistralJudgeProvider(opts: MistralJudgeOptions): JudgeProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "mistral",
		model,
		async judge(input): Promise<JudgeProviderResponse> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("MISTRAL_API_KEY");
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
				response = await fetchImpl(MISTRAL_CHAT_URL, {
					method: "POST",
					headers: {
						authorization: `Bearer ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
						: "fetch failed";
				throw new JudgeProviderError("mistral", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new JudgeProviderError(
					"mistral",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new JudgeProviderError(
					"mistral",
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

function extractMessageContent(raw: unknown): string {
	const result = v.safeParse(ChatCompletionsResponseSchema, raw);
	if (!result.success) {
		throw new JudgeProviderError(
			"mistral",
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const first = result.output.choices[0];
	if (first === undefined) {
		throw new JudgeProviderError("mistral", "response choices array was empty");
	}
	return first.message.content;
}

function parseJudgeContent(content: string): JudgeProviderResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new JudgeOutputParseError("mistral", content, "content was not valid JSON", {
			cause,
		});
	}
	const result = v.safeParse(JudgeContentSchema, parsed);
	if (!result.success) {
		throw new JudgeOutputParseError(
			"mistral",
			content,
			`content failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const score = result.output.score;
	if (!Number.isFinite(score)) {
		throw new JudgeOutputParseError("mistral", content, "score was not a finite number");
	}
	const intScore = Math.round(score);
	if (intScore < 0 || intScore > 100) {
		throw new JudgeOutputParseError(
			"mistral",
			content,
			`score ${intScore} outside the 0..100 range`,
		);
	}
	return { score: intScore, reason: result.output.reason };
}
