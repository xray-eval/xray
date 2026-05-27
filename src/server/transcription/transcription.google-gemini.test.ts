import { makeFetch } from "@/server/core/test-utils.ts";

import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import { createGoogleGeminiTranscriptionProvider } from "./transcription.google-gemini.ts";
import { describe, expect, it } from "bun:test";

interface GeminiBody {
	systemInstruction?: unknown;
	contents?: unknown;
	generationConfig?: unknown;
}

function asGeminiBody(value: unknown): GeminiBody | null {
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

describe("createGoogleGeminiTranscriptionProvider", () => {
	it("posts to generateContent with the model in the URL and x-goog-api-key header", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: GeminiBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("x-goog-api-key") ?? "";
			const parsed = asGeminiBody(body);
			if (parsed !== null) observedBody = parsed;
			return geminiResponse(JSON.stringify({ text: "hello world", language: "en" }));
		});
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIzaTESTKEY",
			fetchImpl,
		});
		await provider.transcribe({
			audio: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7]),
			sampleRate: 16_000,
			language: "en",
		});
		expect(observedUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		);
		expect(observedAuth).toBe("AIzaTESTKEY");
		expect(observedBody.contents).toBeDefined();
		expect(observedBody.systemInstruction).toBeDefined();
		expect(observedBody.generationConfig).toBeDefined();
	});

	it("respects an explicit model override", async () => {
		let observedUrl = "";
		const fetchImpl = makeFetch(({ url }) => {
			observedUrl = url;
			return geminiResponse(JSON.stringify({ text: "x" }));
		});
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			model: "gemini-2.5-pro",
			fetchImpl,
		});
		await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(observedUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
		);
	});

	it("parses model JSON into TranscriptionResult and computes durationMs locally", async () => {
		const fetchImpl = makeFetch(() =>
			geminiResponse(JSON.stringify({ text: "hi there", language: "en" })),
		);
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		const result = await provider.transcribe({
			// 1600 samples @ 16kHz = 100ms
			audio: new Int16Array(1600),
			sampleRate: 16_000,
		});
		expect(result.text).toBe("hi there");
		if (result.language === null) throw new Error("expected language");
		expect(result.language).toBe("en");
		expect(result.durationMs).toBe(100);
		// Gemini provider never returns word timings (capability gap vs. Whisper).
		expect(result.words).toBeNull();
	});

	it("defaults language to null when the model omits it", async () => {
		const fetchImpl = makeFetch(() => geminiResponse(JSON.stringify({ text: "ok" })));
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		const result = await provider.transcribe({
			audio: new Int16Array([0]),
			sampleRate: 16_000,
		});
		expect(result.language).toBeNull();
	});

	it("throws MissingProviderCredentialError(GOOGLE_API_KEY) when key is undefined", async () => {
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => undefined,
			fetchImpl: fetch,
		});
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("GOOGLE_API_KEY");
	});

	it("throws TranscriptionProviderError on 4xx/5xx response, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("rate limited", { status: 429 }));
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(429);
	});

	it("redacts AIza... keys echoed in error bodies", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response("API key AIzaSyA1234567890ABCDEF1234567890ABCDEFGH was invalid", {
					status: 400,
				}),
		);
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.message).toContain("AIza***");
		expect(err.message).not.toContain("AIzaSyA1234567890ABCDEF1234567890ABCDEFGH");
	});

	it("throws TranscriptionProviderError on a safety-blocked prompt", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.message).toContain("SAFETY");
	});

	it("throws TranscriptionProviderError on an empty candidates array", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ candidates: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});

	it("throws TranscriptionProviderError when the model JSON fails the responseSchema contract", async () => {
		const fetchImpl = makeFetch(() => geminiResponse("not json"));
		const provider = createGoogleGeminiTranscriptionProvider({
			apiKey: () => "AIza",
			fetchImpl,
		});
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});
});
