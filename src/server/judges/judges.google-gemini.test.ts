import type { FetchLike } from "@/server/transcription/transcription.openai-whisper.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import { createGoogleGeminiJudgeProvider } from "./judges.google-gemini.ts";
import { describe, expect, it } from "bun:test";

function makeFetch(
	handler: (req: { url: string; headers: Headers; body: unknown }) => Response,
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const headers = new Headers(init?.headers ?? {});
		let body: unknown = init?.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {
				/* leave as string */
			}
		}
		return handler({ url, headers, body });
	};
}

interface GeminiBody {
	systemInstruction?: unknown;
	contents?: unknown;
	generationConfig?: unknown;
}

function asGeminiBody(value: unknown): GeminiBody | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value;
}

interface GenerationConfig {
	temperature?: unknown;
	responseMimeType?: unknown;
	responseSchema?: unknown;
}

function asGenerationConfig(value: unknown): GenerationConfig | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value;
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
