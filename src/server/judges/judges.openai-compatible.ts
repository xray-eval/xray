import * as v from "valibot";

import type { FetchLike } from "@/server/core/fetch.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import type { JudgeProvider, JudgeProviderResponse } from "./judges.types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

// Validate the Chat Completions response at the boundary per
// `.claude/rules/boundary-validation.md`. We model only the path we read:
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

/**
 * Per-provider constants for an OpenAI-compatible Chat Completions API.
 * Both OpenAI and Mistral expose the identical request/response contract
 * (Mistral's API is OpenAI-compatible), so the only things that vary are
 * these four values — everything else (auth header, json_object mode,
 * response parsing, error mapping) is shared in `createOpenAICompatibleChatJudge`.
 *
 * Gemini is deliberately NOT modeled here: its wire format
 * (`candidates[].content.parts[]`, `x-goog-api-key`, `responseSchema`) is
 * genuinely different and lives in its own file.
 */
export interface OpenAICompatibleChatJudgeConfig {
	/** Stable provider name; tags `JudgeProvider.name` and every thrown error. */
	readonly name: string;
	readonly chatUrl: string;
	readonly defaultModel: string;
	/** Env var named in `MissingProviderCredentialError` when the key is absent. */
	readonly credentialEnvVar: string;
}

export interface OpenAICompatibleChatJudgeOptions {
	/** Read at call time, not at construction — env can be loaded between
	 *  server boot and the first judge request. */
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Build a judge provider over an OpenAI-compatible Chat Completions API.
 * Forces `response_format: json_object` and parses the reply as
 * `{ score: int, reason: string }`. Variant-agnostic — the variant runner
 * (e.g. text_match) owns the prompt design.
 *
 * Why a factory instead of a copy per provider: OpenAI and Mistral share
 * this contract byte for byte. A single implementation means a parse-bug
 * fix lands once instead of drifting between two near-identical files.
 */
export function createOpenAICompatibleChatJudge(
	config: OpenAICompatibleChatJudgeConfig,
	opts: OpenAICompatibleChatJudgeOptions,
): JudgeProvider {
	const model = opts.model ?? config.defaultModel;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: config.name,
		model,
		async judge(input): Promise<JudgeProviderResponse> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError(config.credentialEnvVar);
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
				response = await fetchImpl(config.chatUrl, {
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
				throw new JudgeProviderError(config.name, message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new JudgeProviderError(
					config.name,
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new JudgeProviderError(
					config.name,
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}
			const content = extractMessageContent(config.name, raw);
			return parseJudgeContent(config.name, content);
		},
	};
}

function extractMessageContent(provider: string, raw: unknown): string {
	const result = v.safeParse(ChatCompletionsResponseSchema, raw);
	if (!result.success) {
		throw new JudgeProviderError(
			provider,
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const first = result.output.choices[0];
	if (first === undefined) {
		throw new JudgeProviderError(provider, "response choices array was empty");
	}
	return first.message.content;
}

function parseJudgeContent(provider: string, content: string): JudgeProviderResponse {
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
