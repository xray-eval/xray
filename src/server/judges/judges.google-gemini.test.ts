import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import { createGoogleGeminiJudgeProvider } from "./judges.google-gemini.ts";
import { describe, expect, it } from "bun:test";

const GeminiBodySchema = v.object({
	systemInstruction: v.optional(v.unknown()),
	contents: v.optional(v.unknown()),
	generationConfig: v.optional(v.unknown()),
});
type GeminiBody = v.InferOutput<typeof GeminiBodySchema>;

function asGeminiBody(value: unknown): GeminiBody | null {
	const result = v.safeParse(GeminiBodySchema, value);
	return result.success ? result.output : null;
}

const GenerationConfigSchema = v.object({
	temperature: v.optional(v.unknown()),
	responseMimeType: v.optional(v.unknown()),
	responseSchema: v.optional(v.unknown()),
});
type GenerationConfig = v.InferOutput<typeof GenerationConfigSchema>;

function asGenerationConfig(value: unknown): GenerationConfig | null {
	const result = v.safeParse(GenerationConfigSchema, value);
	return result.success ? result.output : null;
}

function geminiResponse(text: string): Response {
	return new Response(
		JSON.stringify({
			candidates: [
				{
					content: { parts: [{ text }] },
					finishReason: "STOP",
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("createGoogleGeminiJudgeProvider", () => {
	it("posts to generateContent with x-goog-api-key, default gemini-3.5-flash, temperature 0, json responseSchema", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: GeminiBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("x-goog-api-key") ?? "";
			const parsed = asGeminiBody(body);
			if (parsed !== null) observedBody = parsed;
			return geminiResponse(JSON.stringify({ score: 80, reason: "matches" }));
		});
		const provider = createGoogleGeminiJudgeProvider({
			apiKey: () => "AIzaTESTKEY",
			fetchImpl,
		});
		await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
		);
		expect(observedAuth).toBe("AIzaTESTKEY");
		const cfg = asGenerationConfig(observedBody.generationConfig);
		expect(cfg?.temperature).toBe(0);
		expect(cfg?.responseMimeType).toBe("application/json");
		expect(cfg?.responseSchema).toBeDefined();
	});

	it("respects an explicit model override", async () => {
		let observedUrl = "";
		const fetchImpl = makeFetch(({ url }) => {
			observedUrl = url;
			return geminiResponse(JSON.stringify({ score: 90, reason: "ok" }));
		});
		const provider = createGoogleGeminiJudgeProvider({
			apiKey: () => "AIza",
			model: "gemini-2.5-flash",
			fetchImpl,
		});
		await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(observedUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
	});

	it("returns the parsed score + reason on a valid response", async () => {
		const fetchImpl = makeFetch(() =>
			geminiResponse(JSON.stringify({ score: 72, reason: "agent confirmed the booking" })),
		);
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(72);
		expect(out.reason).toBe("agent confirmed the booking");
	});

	it("rounds non-integer scores to the nearest integer", async () => {
		const fetchImpl = makeFetch(() => geminiResponse(JSON.stringify({ score: 87.6, reason: "x" })));
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(88);
	});

	it("throws JudgeProviderError on 4xx/5xx, preserving status code", async () => {
		const fetchImpl = makeFetch(() => new Response("nope", { status: 401 }));
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(401);
	});

	it("throws JudgeProviderError on safety block", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.message).toContain("SAFETY");
	});

	it("throws JudgeOutputParseError when the model's content is not valid JSON", async () => {
		const fetchImpl = makeFetch(() => geminiResponse("not json"));
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when score is outside 0..100", async () => {
		const fetchImpl = makeFetch(() => geminiResponse(JSON.stringify({ score: 150, reason: "x" })));
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when reason is missing", async () => {
		const fetchImpl = makeFetch(() => geminiResponse(JSON.stringify({ score: 50 })));
		const provider = createGoogleGeminiJudgeProvider({ apiKey: () => "AIza", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});
});
