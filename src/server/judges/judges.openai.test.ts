import { makeFetch } from "@/server/core/test-utils.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import { createOpenAIJudgeProvider } from "./judges.openai.ts";
import { describe, expect, it } from "bun:test";

interface ChatBody {
	model?: unknown;
	temperature?: unknown;
	response_format?: unknown;
}

function asChatBody(value: unknown): ChatBody | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value;
}

interface ResponseFormat {
	type?: unknown;
}

function asResponseFormat(value: unknown): ResponseFormat | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value;
}

function chatResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createOpenAIJudgeProvider", () => {
	it("posts to /v1/chat/completions with json_object response_format, pinned gpt-4o snapshot, temperature 0", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: ChatBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			const parsed = asChatBody(body);
			if (parsed !== null) observedBody = parsed;
			return chatResponse(JSON.stringify({ score: 80, reason: "matches" }));
		});
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk-test", fetchImpl });
		await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe("https://api.openai.com/v1/chat/completions");
		expect(observedAuth).toBe("Bearer sk-test");
		// Pinned snapshot, not the floating `gpt-4o` alias — verdict
		// stability across days.
		expect(observedBody.model).toBe("gpt-4o-2024-08-06");
		expect(observedBody.temperature).toBe(0);
		const rf = asResponseFormat(observedBody.response_format);
		expect(rf?.type).toBe("json_object");
	});

	it("respects an explicit model override", async () => {
		let observedModel = "";
		const fetchImpl = makeFetch(({ body }) => {
			const parsed = asChatBody(body);
			if (parsed !== null && typeof parsed.model === "string") observedModel = parsed.model;
			return chatResponse(JSON.stringify({ score: 90, reason: "ok" }));
		});
		const provider = createOpenAIJudgeProvider({
			apiKey: () => "sk",
			model: "gpt-4o-mini",
			fetchImpl,
		});
		await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(observedModel).toBe("gpt-4o-mini");
	});

	it("returns the parsed score + reason on a valid response", async () => {
		const fetchImpl = makeFetch(() =>
			chatResponse(JSON.stringify({ score: 72, reason: "agent confirmed the booking" })),
		);
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(72);
		expect(out.reason).toBe("agent confirmed the booking");
	});

	it("rounds non-integer scores to the nearest integer", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 87.6, reason: "x" })));
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(88);
	});

	it("throws JudgeProviderError on 4xx/5xx, preserving status code", async () => {
		const fetchImpl = makeFetch(() => new Response("nope", { status: 401 }));
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(401);
	});

	it("throws JudgeOutputParseError when the model's content is not valid JSON", async () => {
		const fetchImpl = makeFetch(() => chatResponse("not json"));
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when score is outside 0..100", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 150, reason: "x" })));
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when reason is missing", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 50 })));
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});
});
