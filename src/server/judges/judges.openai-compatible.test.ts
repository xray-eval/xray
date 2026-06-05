import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { JudgeOutputParseError, JudgeProviderError } from "./judges.errors.ts";
import { createOpenAICompatibleChatJudge } from "./judges.openai-compatible.ts";
import { describe, expect, it } from "bun:test";

// A synthetic provider config exercising the shared factory in isolation
// from the real OpenAI / Mistral wiring — the per-provider files only need
// to assert their own url/model/credential (see judges.openai.test.ts,
// judges.mistral.test.ts). The parse + error matrix lives here, once.
const CONFIG = {
	name: "acme",
	chatUrl: "https://api.acme.test/v1/chat/completions",
	defaultModel: "acme-judge-1",
	credentialEnvVar: "ACME_API_KEY",
} as const;

const ChatBodySchema = v.object({
	model: v.optional(v.unknown()),
	temperature: v.optional(v.unknown()),
	response_format: v.optional(v.unknown()),
	messages: v.optional(v.unknown()),
});
type ChatBody = v.InferOutput<typeof ChatBodySchema>;

function asChatBody(value: unknown): ChatBody | null {
	const result = v.safeParse(ChatBodySchema, value);
	return result.success ? result.output : null;
}

const ResponseFormatSchema = v.object({ type: v.optional(v.unknown()) });
function asResponseFormatType(value: unknown): unknown {
	const result = v.safeParse(ResponseFormatSchema, value);
	return result.success ? result.output.type : undefined;
}

function chatResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createOpenAICompatibleChatJudge", () => {
	it("posts to the configured url with json_object response_format, the configured default model, temperature 0, and system+user messages", async () => {
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
		const provider = createOpenAICompatibleChatJudge(CONFIG, {
			apiKey: () => "ak-test",
			fetchImpl,
		});
		expect(provider.name).toBe("acme");
		expect(provider.model).toBe("acme-judge-1");
		await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe("https://api.acme.test/v1/chat/completions");
		expect(observedAuth).toBe("Bearer ak-test");
		expect(observedBody.model).toBe("acme-judge-1");
		expect(observedBody.temperature).toBe(0);
		expect(asResponseFormatType(observedBody.response_format)).toBe("json_object");
		expect(observedBody.messages).toEqual([
			{ role: "system", content: "sys" },
			{ role: "user", content: "user" },
		]);
	});

	it("respects an explicit model override", async () => {
		let observedModel: unknown;
		const fetchImpl = makeFetch(({ body }) => {
			observedModel = asChatBody(body)?.model;
			return chatResponse(JSON.stringify({ score: 90, reason: "ok" }));
		});
		const provider = createOpenAICompatibleChatJudge(CONFIG, {
			apiKey: () => "ak",
			model: "acme-judge-pro",
			fetchImpl,
		});
		await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(observedModel).toBe("acme-judge-pro");
	});

	it("returns the parsed score + reason on a valid response", async () => {
		const fetchImpl = makeFetch(() =>
			chatResponse(JSON.stringify({ score: 72, reason: "agent confirmed the booking" })),
		);
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(72);
		expect(out.reason).toBe("agent confirmed the booking");
	});

	it("rounds non-integer scores to the nearest integer", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 87.6, reason: "x" })));
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		const out = await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(out.score).toBe(88);
	});

	it("throws MissingProviderCredentialError naming the configured env var when the key is absent", async () => {
		const provider = createOpenAICompatibleChatJudge(CONFIG, {
			apiKey: () => undefined,
			fetchImpl: fetch,
		});
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("ACME_API_KEY");
	});

	it("throws JudgeProviderError tagged with the provider name on 4xx/5xx, preserving status code", async () => {
		const fetchImpl = makeFetch(() => new Response("nope", { status: 401 }));
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) {
			throw new Error(`expected JudgeProviderError, got ${err}`);
		}
		expect(err.provider).toBe("acme");
		expect(err.statusCode).toBe(401);
	});

	it("redacts provider secrets echoed in an error body", async () => {
		const fetchImpl = makeFetch(
			() => new Response("bad key sk-secret123456789 rejected", { status: 401 }),
		);
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof JudgeProviderError)) throw new Error("expected JudgeProviderError");
		expect(err.message).not.toContain("sk-secret123456789");
	});

	it("throws JudgeProviderError when the response envelope is the wrong shape", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ choices: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeProviderError,
		);
	});

	it("throws JudgeOutputParseError when the model's content is not valid JSON", async () => {
		const fetchImpl = makeFetch(() => chatResponse("not json"));
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when score is outside 0..100", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 150, reason: "x" })));
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});

	it("throws JudgeOutputParseError when reason is missing", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ score: 50 })));
		const provider = createOpenAICompatibleChatJudge(CONFIG, { apiKey: () => "ak", fetchImpl });
		await expect(provider.judge({ systemPrompt: "s", userPrompt: "u" })).rejects.toBeInstanceOf(
			JudgeOutputParseError,
		);
	});
});
