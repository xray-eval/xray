import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { createBedrockJudgeProvider } from "./judges.bedrock.ts";
import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import { describe, expect, it } from "bun:test";

const BedrockBodySchema = v.object({
	system: v.optional(v.unknown()),
	messages: v.optional(v.unknown()),
	inferenceConfig: v.optional(v.unknown()),
	additionalModelRequestFields: v.optional(v.unknown()),
});
type BedrockBody = v.InferOutput<typeof BedrockBodySchema>;

function asBedrockBody(value: unknown): BedrockBody | null {
	const result = v.safeParse(BedrockBodySchema, value);
	return result.success ? result.output : null;
}

const InferenceConfigSchema = v.object({
	maxTokens: v.optional(v.number()),
	temperature: v.optional(v.unknown()),
});

const AdditionalFieldsSchema = v.object({
	thinking: v.optional(v.unknown()),
	output_config: v.optional(v.object({ effort: v.optional(v.string()) })),
});

function converseResponse(content: unknown[]): Response {
	return new Response(
		JSON.stringify({
			output: { message: { role: "assistant", content } },
			stopReason: "end_turn",
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function converseTextResponse(text: string): Response {
	return converseResponse([{ text }]);
}

describe("createBedrockJudgeProvider", () => {
	it("posts to the Converse endpoint with bearer auth, the default Opus 4.8 model, adaptive thinking, xhigh effort, and no temperature", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: BedrockBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			const parsed = asBedrockBody(body);
			if (parsed !== null) observedBody = parsed;
			return converseTextResponse(JSON.stringify({ score: 80, reason: "matches" }));
		});
		const provider = createBedrockJudgeProvider({ apiKey: () => "bedrock-key", fetchImpl });
		await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe(
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-opus-4-8/converse",
		);
		expect(observedAuth).toBe("Bearer bedrock-key");
		expect(observedBody.system).toBeDefined();
		expect(observedBody.messages).toBeDefined();
		const cfg = v.parse(InferenceConfigSchema, observedBody.inferenceConfig);
		expect(cfg.maxTokens).toBeGreaterThan(0);
		// Opus 4.7+ rejects any non-default temperature with a 400 — the
		// request must not carry one.
		expect(cfg.temperature).toBeUndefined();
		const extra = v.parse(AdditionalFieldsSchema, observedBody.additionalModelRequestFields);
		expect(extra.thinking).toEqual({ type: "adaptive" });
		expect(extra.output_config?.effort).toBe("xhigh");
	});

	it("respects model, region, and effort overrides, URL-encoding the model id", async () => {
		let observedUrl = "";
		let observedBody: BedrockBody = {};
		const fetchImpl = makeFetch(({ url, body }) => {
			observedUrl = url;
			const parsed = asBedrockBody(body);
			if (parsed !== null) observedBody = parsed;
			return converseTextResponse(JSON.stringify({ score: 90, reason: "ok" }));
		});
		const provider = createBedrockJudgeProvider({
			apiKey: () => "k",
			model: "us.amazon.nova-2-lite-v1:0",
			region: "eu-central-1",
			effort: "medium",
			fetchImpl,
		});
		expect(provider.model).toBe("us.amazon.nova-2-lite-v1:0");
		await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(observedUrl).toBe(
			"https://bedrock-runtime.eu-central-1.amazonaws.com/model/us.amazon.nova-2-lite-v1%3A0/converse",
		);
		const extra = v.parse(AdditionalFieldsSchema, observedBody.additionalModelRequestFields);
		expect(extra.output_config?.effort).toBe("medium");
	});

	it("returns the parsed score + reason on a valid response", async () => {
		const fetchImpl = makeFetch(() =>
			converseTextResponse(JSON.stringify({ score: 72, reason: "agent confirmed the booking" })),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(72);
		expect(out.reason).toBe("agent confirmed the booking");
	});

	it("skips reasoningContent blocks and reads the first text block", async () => {
		const fetchImpl = makeFetch(() =>
			converseResponse([
				{ reasoningContent: { reasoningText: { text: "thinking..." } } },
				{ text: JSON.stringify({ score: 65, reason: "verdict" }) },
			]),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(65);
		expect(out.reason).toBe("verdict");
	});

	it("unwraps a markdown-fenced JSON reply", async () => {
		const fetchImpl = makeFetch(() =>
			converseTextResponse('```json\n{"score": 55, "reason": "fenced"}\n```'),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(55);
		expect(out.reason).toBe("fenced");
	});

	it("throws MissingProviderCredentialError(AWS_BEARER_TOKEN_BEDROCK) when the key is undefined", async () => {
		const provider = createBedrockJudgeProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("AWS_BEARER_TOKEN_BEDROCK");
	});

	it("throws JudgeProviderError on 4xx/5xx, preserving status code", async () => {
		const fetchImpl = makeFetch(() => new Response("nope", { status: 403 }));
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(403);
		expect(err.provider).toBe("bedrock");
	});

	it("redacts ABSK bearer keys echoed in error bodies", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response("key ABSKQmVkcm9ja0FQSUtleTEyMzQ1Njc4OTAxMjM0NTY3ODkw was rejected", {
					status: 401,
				}),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.message).toContain("ABSK***");
		expect(err.message).not.toContain("ABSKQmVkcm9ja0FQSUtleTEyMzQ1Njc4OTAxMjM0NTY3ODkw");
	});

	it("throws JudgeProviderError when the response has no text content block", async () => {
		const fetchImpl = makeFetch(() =>
			converseResponse([{ reasoningContent: { reasoningText: { text: "only thinking" } } }]),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeProviderError,
		);
	});

	it("throws JudgeProviderError when the response body fails validation", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ unexpected: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeProviderError,
		);
	});

	it("throws JudgeOutputParseError when the model's content is not valid JSON", async () => {
		const fetchImpl = makeFetch(() => converseTextResponse("not json"));
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when score is outside 0..100", async () => {
		const fetchImpl = makeFetch(() =>
			converseTextResponse(JSON.stringify({ score: -5, reason: "x" })),
		);
		const provider = createBedrockJudgeProvider({ apiKey: () => "k", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});
});
