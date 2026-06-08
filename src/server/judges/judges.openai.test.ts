import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { createOpenAIJudgeProvider } from "./judges.openai.ts";
import { describe, expect, it } from "bun:test";

// The request/parse/error behavior is covered once in
// judges.openai-compatible.test.ts. This file pins only what the OpenAI
// wrapper configures: its url, default model, and credential env var.

const ModelSchema = v.object({ model: v.optional(v.unknown()) });
function observedModel(body: unknown): unknown {
	const result = v.safeParse(ModelSchema, body);
	return result.success ? result.output.model : undefined;
}

function chatResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createOpenAIJudgeProvider", () => {
	it("posts to the OpenAI chat URL with the pinned gpt-4o snapshot and parses the verdict", async () => {
		let observedUrl = "";
		let model: unknown;
		const fetchImpl = makeFetch(({ url, body }) => {
			observedUrl = url;
			model = observedModel(body);
			return chatResponse(JSON.stringify({ score: 72, reason: "agent confirmed the booking" }));
		});
		const provider = createOpenAIJudgeProvider({ apiKey: () => "sk-test", fetchImpl });
		expect(provider.name).toBe("openai");
		const out = await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe("https://api.openai.com/v1/chat/completions");
		// Pinned snapshot, not the floating `gpt-4o` alias — verdict stability.
		expect(model).toBe("gpt-4o-2024-08-06");
		expect(provider.model).toBe("gpt-4o-2024-08-06");
		expect(out.score).toBe(72);
	});

	it("respects an explicit model override", async () => {
		let model: unknown;
		const fetchImpl = makeFetch(({ body }) => {
			model = observedModel(body);
			return chatResponse(JSON.stringify({ score: 90, reason: "ok" }));
		});
		const provider = createOpenAIJudgeProvider({
			apiKey: () => "sk",
			model: "gpt-4o-mini",
			fetchImpl,
		});
		await provider.judge({ systemPrompt: "s", userPrompt: "u" });
		expect(model).toBe("gpt-4o-mini");
	});

	it("names OPENAI_API_KEY in the missing-credential error", async () => {
		const provider = createOpenAIJudgeProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.judge({ systemPrompt: "s", userPrompt: "u" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("OPENAI_API_KEY");
	});
});
