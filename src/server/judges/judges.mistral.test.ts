import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import { createMistralJudgeProvider } from "./judges.mistral.ts";
import { describe, expect, it } from "bun:test";

const ChatBodySchema = v.object({
	model: v.optional(v.unknown()),
	temperature: v.optional(v.unknown()),
	response_format: v.optional(v.unknown()),
});
type ChatBody = v.InferOutput<typeof ChatBodySchema>;

function asChatBody(value: unknown): ChatBody | null {
	const result = v.safeParse(ChatBodySchema, value);
	return result.success ? result.output : null;
}

const ResponseFormatSchema = v.object({
	type: v.optional(v.unknown()),
});
type ResponseFormat = v.InferOutput<typeof ResponseFormatSchema>;

function asResponseFormat(value: unknown): ResponseFormat | null {
	const result = v.safeParse(ResponseFormatSchema, value);
	return result.success ? result.output : null;
}

function chatResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createMistralJudgeProvider", () => {
	it("posts to /v1/chat/completions with json_object response_format, pinned model snapshot, temperature 0", async () => {
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
		const provider = createMistralJudgeProvider({ apiKey: () => "mk-test", fetchImpl });
		await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe("https://api.mistral.ai/v1/chat/completions");
		expect(observedAuth).toBe("Bearer mk-test");
		// Pinned dated snapshot, not the floating `mistral-medium-latest`
		// alias — verdict stability across days.
		expect(observedBody.model).toBe("mistral-medium-2604");
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
		const provider = createMistralJudgeProvider({
			apiKey: () => "mk",
			model: "mistral-large-2512",
			fetchImpl,
		});
		await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(observedModel).toBe("mistral-large-2512");
	});

	it("returns the parsed score + reason on a valid response", async () => {
		const fetchImpl = makeFetch(() =>
			chatResponse(JSON.stringify({ score: 72, reason: "agent confirmed the booking" })),
		);
		const provider = createMistralJudgeProvider({ apiKey: () => "mk", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(72);
		expect(out.reason).toBe("agent confirmed the booking");
	});

	it("rounds non-integer scores to the nearest integer", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 87.6, reason: "x" })));
		const provider = createMistralJudgeProvider({ apiKey: () => "mk", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(88);
	});

	it("throws MissingProviderCredentialError naming MISTRAL_API_KEY when the apiKey resolver returns undefined", async () => {
		const provider = createMistralJudgeProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("MISTRAL_API_KEY");
	});

	it("throws JudgeProviderError on 4xx/5xx, preserving status code", async () => {
		const fetchImpl = makeFetch(() => new Response("nope", { status: 401 }));
		const provider = createMistralJudgeProvider({ apiKey: () => "mk", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.provider).toBe("mistral");
		expect(err.statusCode).toBe(401);
	});

	it("throws JudgeOutputParseError when the model's content is not valid JSON", async () => {
		const fetchImpl = makeFetch(() => chatResponse("not json"));
		const provider = createMistralJudgeProvider({ apiKey: () => "mk", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when score is outside 0..100", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 150, reason: "x" })));
		const provider = createMistralJudgeProvider({ apiKey: () => "mk", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when reason is missing", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 50 })));
		const provider = createMistralJudgeProvider({ apiKey: () => "mk", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});
});
