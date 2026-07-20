import * as v from "valibot";

import type { AwsCredentials } from "@/server/core/aws-sigv4.ts";
import { signAwsRequest } from "@/server/core/aws-sigv4.ts";
import type { FetchLike } from "@/server/core/fetch.ts";
import { stripCodeFences } from "@/server/core/model-output.ts";
import { redactProviderSecrets } from "@/server/core/redact.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { parseJudgeContent } from "./judges.content.ts";
import { JudgeProviderError } from "./judges.errors.ts";
import type { JudgeProvider, JudgeProviderResponse } from "./judges.types.ts";

// Bedrock ships Opus 4.8 without a dated suffix — `anthropic.claude-opus-4-8`
// IS the pinned id (AWS's post-4.6 naming, no floating `-latest` alias to
// avoid). The `global.` prefix is the global cross-region inference profile:
// widest availability, no per-geo capacity constraint. Operators with data
// residency needs pin a geo profile (`eu.anthropic.claude-opus-4-8`) via
// XRAY_JUDGE_MODEL.
const DEFAULT_MODEL = "global.anthropic.claude-opus-4-8";
const DEFAULT_REGION = "us-east-1";
// Verdict quality over cost, deliberately: `xhigh` lets the judge spend
// substantially more thinking on each verdict. Cheaper effort levels are a
// constructor option, not an env knob, until an operator actually asks.
const DEFAULT_EFFORT = "xhigh";
const DEFAULT_TIMEOUT_MS = 120_000;
// Generous because adaptive thinking spends from the same budget as the
// reply; a verdict whose thinking exhausts maxTokens returns no text block.
const MAX_TOKENS = 16_384;

// Converse response, modeled only down to the path we read: the first
// content block that carries `text`. Reasoning blocks (`reasoningContent`)
// come back first when thinking triggers — `v.object` strips their keys,
// leaving `{}` entries we skip.
const ConverseResponseSchema = v.object({
	output: v.object({
		message: v.object({
			content: v.array(v.object({ text: v.optional(v.string()) })),
		}),
	}),
});

export type BedrockJudgeEffort = "low" | "medium" | "high" | "xhigh";

export interface BedrockJudgeOptions {
	/** Bearer token (`AWS_BEARER_TOKEN_BEDROCK`). Read at call time, not at
	 *  construction — env can be loaded between boot and the first request.
	 *  Takes precedence over `awsCredentials` when both resolve. */
	readonly apiKey: () => string | undefined;
	/** SigV4 fallback: access-key credentials (`AWS_ACCESS_KEY_ID` /
	 *  `AWS_SECRET_ACCESS_KEY` / optional `AWS_SESSION_TOKEN`). Used when no
	 *  bearer token is present — lets operators authenticate with the AWS
	 *  credential form they already have (access keys, assumed roles) instead
	 *  of minting a Bedrock API key. Also read at call time. */
	readonly awsCredentials?: () => AwsCredentials | undefined;
	readonly region?: string;
	readonly model?: string;
	readonly effort?: BedrockJudgeEffort;
	readonly fetchImpl?: FetchLike;
	readonly timeoutMs?: number;
}

/**
 * AWS Bedrock judge provider over the Converse API. Authenticates with
 * either a Bedrock API key (bearer, `AWS_BEARER_TOKEN_BEDROCK`) or, when no
 * bearer token is present, AWS SigV4 access-key credentials — the latter
 * signed in-process over `node:crypto` (see `core/aws-sigv4.ts`), no AWS
 * SDK dependency either way. Defaults to Claude Opus 4.8 with adaptive
 * thinking and `xhigh` effort (passed through `additionalModelRequestFields`).
 *
 * Two Anthropic-on-Bedrock constraints shape the request:
 *   - No `temperature`: Opus 4.7+ rejects any non-default sampling
 *     parameter with a 400, so unlike the OpenAI-compatible judge this
 *     request carries none.
 *   - No forced-JSON response mode on Converse: the prompt asks for bare
 *     JSON and the reply is fence-stripped before parsing.
 */
export function createBedrockJudgeProvider(opts: BedrockJudgeOptions): JudgeProvider {
	const model = opts.model ?? DEFAULT_MODEL;
	const region = opts.region ?? DEFAULT_REGION;
	const effort = opts.effort ?? DEFAULT_EFFORT;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
	return {
		name: "bedrock",
		model,
		async judge(input): Promise<JudgeProviderResponse> {
			const body = {
				system: [{ text: input.systemPrompt }],
				messages: [{ role: "user", content: [{ text: input.userPrompt }] }],
				inferenceConfig: { maxTokens: MAX_TOKENS },
				additionalModelRequestFields: {
					thinking: { type: "adaptive" },
					output_config: { effort },
				},
			};
			const bodyStr = JSON.stringify(body);
			const headers = resolveAuthHeaders(opts, url, region, bodyStr);

			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers,
					body: bodyStr,
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (cause) {
				const message =
					cause instanceof Error && cause.name === "TimeoutError"
						? `fetch timed out after ${timeoutMs}ms`
						: "fetch failed";
				throw new JudgeProviderError("bedrock", message, null, { cause });
			}

			if (!response.ok) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {
					detail = "<unreadable body>";
				}
				throw new JudgeProviderError(
					"bedrock",
					`HTTP ${response.status}: ${redactProviderSecrets(detail).slice(0, 512)}`,
					response.status,
				);
			}

			let raw: unknown;
			try {
				raw = await response.json();
			} catch (cause) {
				throw new JudgeProviderError(
					"bedrock",
					"response body was not valid JSON",
					response.status,
					{
						cause,
					},
				);
			}
			const content = extractConverseText(raw);
			return parseJudgeContent("bedrock", stripCodeFences(content));
		},
	};
}

// Bearer takes precedence over SigV4 when both resolve; neither → a typed
// credential error naming both accepted forms. SigV4 signs the exact body +
// content-type header that will be sent, so the signature covers the wire.
function resolveAuthHeaders(
	opts: BedrockJudgeOptions,
	url: string,
	region: string,
	bodyStr: string,
): Record<string, string> {
	const bearer = opts.apiKey();
	if (bearer !== undefined && bearer.length > 0) {
		return { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
	}
	const creds = opts.awsCredentials?.();
	if (creds !== undefined && creds.accessKeyId.length > 0 && creds.secretAccessKey.length > 0) {
		return signAwsRequest({
			method: "POST",
			url,
			region,
			service: "bedrock",
			body: bodyStr,
			headers: { "content-type": "application/json" },
			credentials: creds,
		});
	}
	throw new MissingProviderCredentialError(
		"AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY",
	);
}

function extractConverseText(raw: unknown): string {
	const result = v.safeParse(ConverseResponseSchema, raw);
	if (!result.success) {
		throw new JudgeProviderError(
			"bedrock",
			`response failed validation: ${result.issues.map((i) => i.message).join("; ")}`,
		);
	}
	const text = result.output.output.message.content.find((b) => b.text !== undefined)?.text;
	if (text === undefined) {
		throw new JudgeProviderError("bedrock", "response contained no text content block");
	}
	return text;
}
