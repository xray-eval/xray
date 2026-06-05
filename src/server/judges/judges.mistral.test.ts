import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { createMistralJudgeProvider } from "./judges.mistral.ts";
import { describe, expect, it } from "bun:test";

// The request/parse/error behavior is covered once in
// judges.openai-compatible.test.ts. This file pins only what the Mistral
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

describe("createMistralJudgeProvider", () => {
	it("posts to the Mistral chat URL with the pinned default model and parses the verdict", async () => {
		let observedUrl = "";
		let model: unknown;
		const fetchImpl = makeFetch(({ url, body }) => {
			observedUrl = url;
			model = observedModel(body);
			return chatResponse(JSON.stringify({ score: 80, reason: "matches" }));
		});
		const provider = createMistralJudgeProvider({ apiKey: () => "mk-test", fetchImpl });
		expect(provider.name).toBe("mistral");
		const out = await provider.judge({ systemPrompt: "sys", userPrompt: "user" });
		expect(observedUrl).toBe("https://api.mistral.ai/v1/chat/completions");
		// Pinned dated snapshot, not the floating `mistral-medium-latest` alias.
		expect(model).toBe("mistral-medium-2604");
		expect(provider.model).toBe("mistral-medium-2604");
		expect(out.score).toBe(80);
	});

	it("names MISTRAL_API_KEY in the missing-credential error", async () => {
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
});
