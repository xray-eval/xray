import type { FetchLike } from "@/server/core/fetch.ts";
import { makeFetch } from "@/server/core/test-utils.ts";

import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import { createOpenAIWhisperProvider } from "./transcription.openai-whisper.ts";
import { describe, expect, it } from "bun:test";

describe("createOpenAIWhisperProvider", () => {
	it("posts a multipart request to /v1/audio/transcriptions with the model + verbose_json format", async () => {
		const observed: {
			url: string;
			auth: string;
			model: string;
			format: string;
			language: string | null;
		} = { url: "", auth: "", model: "", format: "", language: null };
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observed.url = url;
			observed.auth = headers.get("authorization") ?? "";
			if (body instanceof FormData) {
				observed.model = String(body.get("model") ?? "");
				observed.format = String(body.get("response_format") ?? "");
				const lang = body.get("language");
				observed.language = typeof lang === "string" ? lang : null;
			}
			return new Response(
				JSON.stringify({ text: "hello world", language: "en", duration: 1.5, words: [] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk-test", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7]),
			sampleRate: 16_000,
			language: "en",
		});
		expect(observed.url).toBe("https://api.openai.com/v1/audio/transcriptions");
		expect(observed.auth).toBe("Bearer sk-test");
		expect(observed.model).toBe("whisper-1");
		expect(observed.format).toBe("verbose_json");
		expect(observed.language).toBe("en");
	});

	it("parses verbose_json into TranscriptionResult, including word timings", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(
					JSON.stringify({
						text: "hi there",
						language: "en",
						duration: 0.42,
						words: [
							{ word: "hi", start: 0.0, end: 0.2 },
							{ word: "there", start: 0.21, end: 0.42 },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk-test", fetchImpl });
		const result = await provider.transcribe({
			audio: new Int16Array([0, 0, 0, 0]),
			sampleRate: 16_000,
		});
		expect(result.text).toBe("hi there");
		// Narrow before equality — the union with null trips bun:test's overload.
		if (result.language === null) throw new Error("expected language");
		expect(result.language).toBe("en");
		expect(result.durationMs).toBe(420);
		expect(result.words).toEqual([
			{ text: "hi", startMs: 0, endMs: 200 },
			{ text: "there", startMs: 210, endMs: 420 },
		]);
	});

	it("returns null words when the provider omits them", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ text: "x", duration: 0.1 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk-test", fetchImpl });
		const result = await provider.transcribe({
			audio: new Int16Array([0]),
			sampleRate: 16_000,
		});
		expect(result.words).toBeNull();
	});

	it("throws MissingProviderCredentialError when the apiKey resolver returns undefined", async () => {
		const provider = createOpenAIWhisperProvider({ apiKey: () => undefined, fetchImpl: fetch });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(MissingProviderCredentialError);
	});

	it("throws TranscriptionProviderError on 4xx/5xx response, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("rate limited", { status: 429 }));
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(429);
	});

	it("throws TranscriptionProviderError on a malformed JSON response", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
		);
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});

	it("wraps a rejected fetch as a generic fetch failure", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("simulated network failure");
		};
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.provider).toBe("openai-whisper");
		expect(err.message).toContain("fetch failed");
	});

	it("wraps an AbortSignal timeout with a timeout-specific message", async () => {
		const fetchImpl: FetchLike = async () => {
			throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
		};
		const provider = createOpenAIWhisperProvider({
			apiKey: () => "sk",
			fetchImpl,
			timeoutMs: 5_000,
		});
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.message).toContain("fetch timed out after 5000ms");
	});

	it("wraps a caller-triggered abort with an abort-specific message", async () => {
		const fetchImpl: FetchLike = async () => {
			throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
		};
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk", fetchImpl });
		const controller = new AbortController();
		const err = await provider
			.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000, signal: controller.signal })
			.then(
				() => null,
				(e: unknown) => e,
			);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.message).toContain("fetch aborted by caller");
	});

	it("falls back to '<unreadable body>' when the error body stream errors mid-read", async () => {
		// A ReadableStream that errors on read simulates a connection dropping
		// after the status line but before the body finishes — `.text()`
		// rejects, which is what drives the fallback branch.
		const fetchImpl: FetchLike = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("stream broke"));
					},
				}),
				{ status: 500 },
			);
		const provider = createOpenAIWhisperProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TranscriptionProviderError)) {
			throw new Error(`expected TranscriptionProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(500);
		expect(err.message).toContain("<unreadable body>");
	});
});
