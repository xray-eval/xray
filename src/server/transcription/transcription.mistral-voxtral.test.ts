import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";

import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import { createMistralVoxtralProvider } from "./transcription.mistral-voxtral.ts";
import { describe, expect, it } from "bun:test";

const ChatBodySchema = v.object({
	model: v.optional(v.string()),
	temperature: v.optional(v.number()),
	response_format: v.optional(v.object({ type: v.optional(v.string()) })),
	messages: v.optional(
		v.array(
			v.object({
				role: v.string(),
				content: v.union([
					v.string(),
					v.array(
						v.object({
							type: v.string(),
							text: v.optional(v.string()),
							input_audio: v.optional(v.object({ data: v.string(), format: v.string() })),
						}),
					),
				]),
			}),
		),
	),
});
type ChatBody = v.InferOutput<typeof ChatBodySchema>;

function asChatBody(value: unknown): ChatBody | null {
	const result = v.safeParse(ChatBodySchema, value);
	return result.success ? result.output : null;
}

function chatResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createMistralVoxtralProvider", () => {
	it("posts to chat completions with the pinned voxtral-small model, json mode, temperature 0, and a wav input_audio block", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: ChatBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			const parsed = asChatBody(body);
			if (parsed !== null) observedBody = parsed;
			return chatResponse(JSON.stringify({ text: "hello world", language: "en" }));
		});
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk-test", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7]),
			sampleRate: 16_000,
		});
		expect(observedUrl).toBe("https://api.mistral.ai/v1/chat/completions");
		expect(observedAuth).toBe("Bearer mk-test");
		expect(observedBody.model).toBe("voxtral-small-2507");
		expect(observedBody.temperature).toBe(0);
		expect(observedBody.response_format?.type).toBe("json_object");
		const userMessage = observedBody.messages?.find((m) => m.role === "user");
		if (userMessage === undefined || typeof userMessage.content === "string") {
			throw new Error("expected a content-block user message");
		}
		const audioBlock = userMessage.content.find((b) => b.type === "input_audio")?.input_audio;
		if (audioBlock === undefined) throw new Error("expected an input_audio block");
		expect(audioBlock.format).toBe("wav");
		expect(audioBlock.data.length).toBeGreaterThan(0);
	});

	it("respects an explicit model override", async () => {
		let observedBody: ChatBody = {};
		const fetchImpl = makeFetch(({ body }) => {
			const parsed = asChatBody(body);
			if (parsed !== null) observedBody = parsed;
			return chatResponse(JSON.stringify({ text: "x" }));
		});
		const provider = createMistralVoxtralProvider({
			apiKey: () => "mk",
			model: "voxtral-small-9999",
			fetchImpl,
		});
		expect(provider.model).toBe("voxtral-small-9999");
		await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(observedBody.model).toBe("voxtral-small-9999");
	});

	it("parses model JSON into TranscriptionResult and computes durationMs locally", async () => {
		const fetchImpl = makeFetch(() =>
			chatResponse(JSON.stringify({ text: "hi there", language: "de" })),
		);
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		const result = await provider.transcribe({
			// 1600 samples @ 16kHz = 100ms
			audio: new Int16Array(1600),
			sampleRate: 16_000,
		});
		expect(result.text).toBe("hi there");
		expect(result.language).toBe("de");
		expect(result.durationMs).toBe(100);
		// Chat-audio transcription has no signal-aligned word timings
		// (capability gap vs. Whisper; words_json is nullable).
		expect(result.words).toBeNull();
	});

	it("defaults language to null when the model omits it", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ text: "ok" })));
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		const result = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(result.language).toBeNull();
	});

	it("folds the language hint into the user prompt when provided", async () => {
		let observedBody: ChatBody = {};
		const fetchImpl = makeFetch(({ body }) => {
			const parsed = asChatBody(body);
			if (parsed !== null) observedBody = parsed;
			return chatResponse(JSON.stringify({ text: "x" }));
		});
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0]),
			sampleRate: 16_000,
			language: "de",
		});
		const userMessage = observedBody.messages?.find((m) => m.role === "user");
		if (userMessage === undefined || typeof userMessage.content === "string") {
			throw new Error("expected a content-block user message");
		}
		const textBlock = userMessage.content.find((b) => b.type === "text");
		expect(textBlock?.text).toContain('"de"');
	});

	it("throws MissingProviderCredentialError naming MISTRAL_API_KEY when the key is absent", async () => {
		const provider = createMistralVoxtralProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("MISTRAL_API_KEY");
	});

	it("throws TranscriptionProviderError on 4xx/5xx response, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("rate limited", { status: 429 }));
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(429);
		expect(err.provider).toBe("mistral-voxtral");
	});

	it("throws TranscriptionProviderError when the response has no choices", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ choices: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});

	it("throws TranscriptionProviderError when the model output is not valid JSON", async () => {
		const fetchImpl = makeFetch(() => chatResponse("not json"));
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});

	it("throws TranscriptionProviderError when the model JSON misses the text field", async () => {
		const fetchImpl = makeFetch(() => chatResponse(JSON.stringify({ language: "en" })));
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});
});
