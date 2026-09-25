import * as v from "valibot";

import type { FetchLike } from "@/server/core/fetch.ts";
import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { TtsProviderError } from "./tts.errors.ts";
import { createOpenAITtsProvider } from "./tts.openai.ts";
import { describe, expect, it } from "bun:test";

const SpeechBodySchema = v.object({
	model: v.optional(v.unknown()),
	input: v.optional(v.unknown()),
	voice: v.optional(v.unknown()),
	response_format: v.optional(v.unknown()),
});
type SpeechBody = v.InferOutput<typeof SpeechBodySchema>;

function asSpeechBody(value: unknown): SpeechBody | null {
	const result = v.safeParse(SpeechBodySchema, value);
	return result.success ? result.output : null;
}

function pcmResponse(samples: number[]): Response {
	const pcm = new Int16Array(samples);
	return new Response(new Uint8Array(pcm.buffer.slice(0)), {
		status: 200,
		headers: { "content-type": "application/octet-stream" },
	});
}

describe("createOpenAITtsProvider", () => {
	it("posts to /v1/audio/speech with the pinned model, raw pcm format, and the requested voice", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: SpeechBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			const parsed = asSpeechBody(body);
			if (parsed !== null) observedBody = parsed;
			return pcmResponse([0, 1, 2]);
		});
		const provider = createOpenAITtsProvider({ apiKey: () => "sk-test", fetchImpl });
		await provider.synthesize({ text: "hello", voice: "alloy" });
		expect(observedUrl).toBe("https://api.openai.com/v1/audio/speech");
		expect(observedAuth).toBe("Bearer sk-test");
		expect(observedBody.model).toBe("gpt-4o-mini-tts");
		expect(observedBody.input).toBe("hello");
		expect(observedBody.voice).toBe("alloy");
		expect(observedBody.response_format).toBe("pcm");
	});

	it("decodes the raw little-endian int16 body at 24kHz", async () => {
		const fetchImpl = makeFetch(() => pcmResponse([0, 1000, -1000, 32767]));
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		const result = await provider.synthesize({ text: "x", voice: "alloy" });
		expect(result.sampleRate).toBe(24_000);
		expect([...result.pcm]).toEqual([0, 1000, -1000, 32767]);
	});

	it("exposes name, pinned default model, and default voice", async () => {
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl: fetch });
		expect(provider.name).toBe("openai");
		expect(provider.model).toBe("gpt-4o-mini-tts");
		expect(await provider.resolveDefaultVoice()).toBe("alloy");
		// OpenAI voices are multilingual — language never changes the pick.
		expect(await provider.resolveDefaultVoice("de")).toBe("alloy");
	});

	it("respects an explicit model override", async () => {
		let observedModel: unknown;
		const fetchImpl = makeFetch(({ body }) => {
			observedModel = asSpeechBody(body)?.model;
			return pcmResponse([0]);
		});
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", model: "tts-1-hd", fetchImpl });
		await provider.synthesize({ text: "x", voice: "alloy" });
		expect(observedModel).toBe("tts-1-hd");
	});

	it("throws MissingProviderCredentialError naming OPENAI_API_KEY when the key is absent", async () => {
		const provider = createOpenAITtsProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.synthesize({ text: "x", voice: "alloy" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("OPENAI_API_KEY");
	});

	it("throws TtsProviderError on 4xx/5xx, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("nope", { status: 429 }));
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "alloy" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.provider).toBe("openai");
		expect(err.statusCode).toBe(429);
	});

	it("throws TtsProviderError on an odd-length pcm body", async () => {
		const fetchImpl = makeFetch(() => new Response(new Uint8Array([0, 1, 2]), { status: 200 }));
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "alloy" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});

	it("throws TtsProviderError on an empty pcm body", async () => {
		const fetchImpl = makeFetch(() => new Response(new Uint8Array(0), { status: 200 }));
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "alloy" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});

	it("wraps a rejected fetch as a generic fetch failure", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("simulated network failure");
		};
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "alloy" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.provider).toBe("openai");
		expect(err.message).toContain("fetch failed");
	});

	it("wraps an AbortSignal timeout with a timeout-specific message", async () => {
		const fetchImpl: FetchLike = async () => {
			throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
		};
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl, timeoutMs: 5_000 });
		const err = await provider.synthesize({ text: "x", voice: "alloy" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.message).toContain("fetch timed out after 5000ms");
	});

	it("wraps a caller-triggered abort with an abort-specific message", async () => {
		const fetchImpl: FetchLike = async () => {
			throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
		};
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		const controller = new AbortController();
		const err = await provider
			.synthesize({ text: "x", voice: "alloy", signal: controller.signal })
			.then(
				() => null,
				(e: unknown) => e,
			);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
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
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "alloy" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.statusCode).toBe(500);
		expect(err.message).toContain("<unreadable body>");
	});

	it("throws TtsProviderError when the pcm body's arrayBuffer read throws", async () => {
		// Same broken-stream trick as the error-body test, but on a 200 so it
		// drives `response.arrayBuffer()`'s catch instead of `.text()`'s.
		const fetchImpl: FetchLike = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("stream broke"));
					},
				}),
				{ status: 200 },
			);
		const provider = createOpenAITtsProvider({ apiKey: () => "sk", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "alloy" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.message).toContain("could not read response body");
	});
});
