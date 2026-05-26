import * as v from "valibot";

import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";
import type { FetchLike } from "@/server/transcription/transcription.openai-whisper.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import type { JudgeProvider, JudgeProviderResponse } from "./judges.types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Pinned snapshot for verdict stability — a floating alias would re-point
// under us and drift scores between runs. Operators override via
// XRAY_JUDGE_MODEL.
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_TIMEOUT_MS = 60_000;

const GeminiPartSchema = v.object({
	text: v.optional(v.string()),
});
const GeminiContentSchema = v.object({
	parts: v.optional(v.array(GeminiPartSchema)),
});
const GeminiCandidateSchema = v.object({
	content: v.optional(GeminiContentSchema),
	finishReason: v.optional(v.string()),
});
const GeminiResponseSchema = v.object({
	candidates: v.optional(v.array(GeminiCandidateSchema)),
	promptFeedback: v.optional(
		v.object({
			blockReason: v.optional(v.string()),
		}),
	),
});

const JudgeContentSchema = v.object({
	score: v.number(),
	reason: v.string(),
});

export interface GoogleGeminiJudgeOptions {
	readonly apiKey: () => string | undefined;
	readonly model?: string;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * Google Gemini judge provider. Forces a structured-output JSON reply via
 * `responseSchema` and parses the model's reply as `{ score: int, reason:
 * string }`. Variant-agnostic — same contract as `judges.openai.ts`, the
 * variant runner (e.g. text_match) owns the prompt design.
 */
export function createGoogleGeminiJudgeProvider(opts: GoogleGeminiJudgeOptions): JudgeProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "google-gemini",
		model,
		async judge(input): Promise<JudgeProviderResponse> {
			const key = opts.apiKey();
			if (key === undefined || key.length === 0) {
				throw new MissingProviderCredentialError("GOOGLE_API_KEY");
			}
			const body = {
				systemInstruction: { parts: [{ text: input.systemPrompt }] },
				contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
				generationConfig: {
					temperature: 0,
					responseMimeType: "application/json",
					responseSchema: {
						type: "OBJECT",
						properties: {
							score: { type: "INTEGER" },
							reason: { type: "STRING" },
						},
						required: ["score", "reason"],
					},
				},
			};

			const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers: {
						"x-goog-api-key": key,
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
				throw new JudgeProviderError("google-gemini", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new JudgeProviderError(
					"google-gemini",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new JudgeProviderError(
					"google-gemini",
					"response body was not valid JSON",
					response.status,
					{ cause },
				);
			}
			const content = extractGeminiText(raw);
			return parseJudgeContent(content);
		},
	};
}

function extractGeminiText(raw: unknown): string {
	const result = v.safeParse(GeminiResponseSchema, raw);
	if (!result.success) {
		throw new JudgeProviderError(
			"google-gemini",
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const parsed = result.output;
	const blockReason = parsed.promptFeedback?.blockReason;
	if (blockReason !== undefined) {
		throw new JudgeProviderError(
			"google-gemini",
			`prompt blocked by safety filter: ${blockReason}`,
		);
	}
	const first = parsed.candidates?.[0];
	if (first === undefined) {
		throw new JudgeProviderError("google-gemini", "response candidates array was empty");
	}
	if (first.finishReason !== undefined && first.finishReason !== "STOP") {
		throw new JudgeProviderError(
			"google-gemini",
			`candidate finished with reason "${first.finishReason}" (expected STOP)`,
		);
	}
	const parts = first.content?.parts ?? [];
	const text = parts.map((p) => p.text ?? "").join("");
	if (text.length === 0) {
		throw new JudgeProviderError("google-gemini", "candidate content was empty");
	}
	return text;
}

function parseJudgeContent(content: string): JudgeProviderResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (cause) {
		throw new JudgeOutputParseError("google-gemini", content, "content was not valid JSON", {
			cause,
		});
	}
	const result = v.safeParse(JudgeContentSchema, parsed);
	if (!result.success) {
		throw new JudgeOutputParseError(
			"google-gemini",
			content,
			`content failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const score = result.output.score;
	if (!Number.isFinite(score)) {
		throw new JudgeOutputParseError("google-gemini", content, "score was not a finite number");
	}
	const intScore = Math.round(score);
	if (intScore < 0 || intScore > 100) {
		throw new JudgeOutputParseError(
			"google-gemini",
			content,
			`score ${intScore} outside the 0..100 range`,
		);
	}
	return { score: intScore, reason: result.output.reason };
}
