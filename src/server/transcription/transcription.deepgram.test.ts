import { makeFetch } from "@/server/core/test-utils.ts";

import { createDeepgramProvider } from "./transcription.deepgram.ts";
import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import { describe, expect, it } from "bun:test";

interface DeepgramWord {
	word?: string;
	punctuated_word?: string;
	start?: number;
	end?: number;
}

function deepgramResponse(input: {
	transcript?: string;
	words?: DeepgramWord[] | null;
	detected_language?: string;
}): Response {
	return new Response(
		JSON.stringify({
			metadata: { duration: 2.34 },
			results: {
				channels: [
					{
						...(input.detected_language !== undefined
							? { detected_language: input.detected_language }
							: {}),
						alternatives: [
							{
								...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
								...(input.words !== undefined ? { words: input.words } : {}),
							},
						],
					},
				],
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("createDeepgramProvider", () => {
	it("posts the raw wav to /v1/listen with Token auth, nova-3, smart_format, and detect_language when no hint is given", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedContentType = "";
		let observedBodyBytes = 0;
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			observedContentType = headers.get("content-type") ?? "";
			if (body instanceof Uint8Array) observedBodyBytes = body.byteLength;
			return deepgramResponse({ transcript: "hello", detected_language: "en" });
		});
		const provider = createDeepgramProvider({ apiKey: () => "dg-test", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7]),
			sampleRate: 16_000,
		});
		const parsed = new URL(observedUrl);
		expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.deepgram.com/v1/listen");
		expect(parsed.searchParams.get("model")).toBe("nova-3");
		expect(parsed.searchParams.get("smart_format")).toBe("true");
		expect(parsed.searchParams.get("detect_language")).toBe("true");
		expect(parsed.searchParams.get("language")).toBeNull();
		expect(observedAuth).toBe("Token dg-test");
		expect(observedContentType).toBe("audio/wav");
		expect(observedBodyBytes).toBeGreaterThan(0);
	});

	it("sends the language hint instead of detect_language when provided", async () => {
		let observedUrl = "";
		const fetchImpl = makeFetch(({ url }) => {
			observedUrl = url;
			return deepgramResponse({ transcript: "hallo" });
		});
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0]),
			sampleRate: 16_000,
			language: "de",
		});
		const parsed = new URL(observedUrl);
		expect(parsed.searchParams.get("language")).toBe("de");
		expect(parsed.searchParams.get("detect_language")).toBeNull();
	});

	it("respects an explicit model override", async () => {
		let observedUrl = "";
		const fetchImpl = makeFetch(({ url }) => {
			observedUrl = url;
			return deepgramResponse({ transcript: "x" });
		});
		const provider = createDeepgramProvider({ apiKey: () => "dg", model: "nova-2", fetchImpl });
		expect(provider.model).toBe("nova-2");
		await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(new URL(observedUrl).searchParams.get("model")).toBe("nova-2");
	});

	it("maps transcript, detected language, punctuated word timings, and computes durationMs locally", async () => {
		const fetchImpl = makeFetch(() =>
			deepgramResponse({
				transcript: "Hello. Can you?",
				detected_language: "en",
				words: [
					{ word: "hello", punctuated_word: "Hello.", start: 0, end: 0.64 },
					{ word: "can", punctuated_word: "Can", start: 0.64, end: 0.96 },
					{ word: "you", start: 0.96, end: 1.12 },
				],
			}),
		);
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		const result = await provider.transcribe({
			// 1600 samples @ 16kHz = 100ms
			audio: new Int16Array(1600),
			sampleRate: 16_000,
		});
		expect(result.text).toBe("Hello. Can you?");
		expect(result.language).toBe("en");
		expect(result.durationMs).toBe(100);
		expect(result.words).toEqual([
			{ text: "Hello.", startMs: 0, endMs: 640 },
			{ text: "Can", startMs: 640, endMs: 960 },
			{ text: "you", startMs: 960, endMs: 1120 },
		]);
	});

	it("falls back to the language hint when detection is absent, and to null otherwise", async () => {
		const fetchImpl = makeFetch(() => deepgramResponse({ transcript: "hallo" }));
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		const hinted = await provider.transcribe({
			audio: new Int16Array([0]),
			sampleRate: 16_000,
			language: "de",
		});
		expect(hinted.language).toBe("de");
		const bare = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(bare.language).toBeNull();
	});

	it("returns words null when the response carries none", async () => {
		const fetchImpl = makeFetch(() => deepgramResponse({ transcript: "x", words: [] }));
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		const result = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(result.words).toBeNull();
	});

	it("defaults text to empty when the transcript field is missing", async () => {
		const fetchImpl = makeFetch(() => deepgramResponse({}));
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		const result = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(result.text).toBe("");
	});

	it("throws MissingProviderCredentialError naming DEEPGRAM_API_KEY when the key is absent", async () => {
		const provider = createDeepgramProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("DEEPGRAM_API_KEY");
	});

	it("throws TranscriptionProviderError on 4xx/5xx response, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("insufficient credits", { status: 402 }));
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(402);
		expect(err.provider).toBe("deepgram-nova");
	});

	it("throws TranscriptionProviderError when the response has no alternatives", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ results: { channels: [{ alternatives: [] }] } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});

	it("throws TranscriptionProviderError when the response body fails validation", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ unexpected: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createDeepgramProvider({ apiKey: () => "dg", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});
});
