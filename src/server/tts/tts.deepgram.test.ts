import * as v from "valibot";

import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { createDeepgramTtsProvider } from "./tts.deepgram.ts";
import { NoTtsVoiceForLanguageError, TtsProviderError } from "./tts.errors.ts";
import { describe, expect, it } from "bun:test";

const SpeakBodySchema = v.object({ text: v.optional(v.string()) });

function pcmResponse(samples: number[]): Response {
	const pcm = new Int16Array(samples);
	return new Response(new Uint8Array(pcm.buffer.slice(0)), {
		status: 200,
		headers: { "content-type": "audio/l16;rate=24000" },
	});
}

function modelsResponse(tts: { canonical_name: string; languages: string[] }[]): Response {
	return new Response(JSON.stringify({ tts }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const AURA_CATALOG = [
	{ canonical_name: "aura-2-thalia-en", languages: ["en", "en-US"] },
	{ canonical_name: "aura-2-draco-en", languages: ["en", "en-GB"] },
	{ canonical_name: "aura-2-elara-de", languages: ["de", "de-DE"] },
	{ canonical_name: "aura-2-aurelia-de", languages: ["de", "de-DE"] },
	{ canonical_name: "aura-asteria-en", languages: ["en", "en-US"] },
];

describe("createDeepgramTtsProvider", () => {
	it("posts to /v1/speak with Token auth, the voice as model param, linear16, 24kHz, no container", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedText: string | undefined;
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			const parsed = v.safeParse(SpeakBodySchema, body);
			if (parsed.success) observedText = parsed.output.text;
			return pcmResponse([0, 1, 2]);
		});
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg-test", fetchImpl });
		await provider.synthesize({ text: "hello", voice: "aura-2-thalia-en" });
		const parsed = new URL(observedUrl);
		expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.deepgram.com/v1/speak");
		expect(parsed.searchParams.get("model")).toBe("aura-2-thalia-en");
		expect(parsed.searchParams.get("encoding")).toBe("linear16");
		expect(parsed.searchParams.get("sample_rate")).toBe("24000");
		expect(parsed.searchParams.get("container")).toBe("none");
		expect(observedAuth).toBe("Token dg-test");
		expect(observedText).toBe("hello");
	});

	it("decodes the raw little-endian int16 body at 24kHz", async () => {
		const fetchImpl = makeFetch(() => pcmResponse([0, 1000, -1000, 32767]));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		const result = await provider.synthesize({ text: "x", voice: "aura-2-thalia-en" });
		expect(result.sampleRate).toBe(24_000);
		expect([...result.pcm]).toEqual([0, 1000, -1000, 32767]);
	});

	it("exposes name, model family, and the static default voice", async () => {
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl: fetch });
		expect(provider.name).toBe("deepgram");
		expect(provider.model).toBe("aura-2");
		expect(await provider.resolveDefaultVoice()).toBe("aura-2-thalia-en");
	});

	it("resolves a language via the models catalog, picking the alphabetically first family voice", async () => {
		let observedUrl = "";
		const fetchImpl = makeFetch(({ url }) => {
			observedUrl = url;
			return modelsResponse(AURA_CATALOG);
		});
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		expect(await provider.resolveDefaultVoice("de")).toBe("aura-2-aurelia-de");
		expect(observedUrl).toContain("/v1/models");
	});

	it("prefers an exact regional match over a primary-subtag match", async () => {
		const fetchImpl = makeFetch(() => modelsResponse(AURA_CATALOG));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		expect(await provider.resolveDefaultVoice("en_gb")).toBe("aura-2-draco-en");
	});

	it("only considers voices of the configured model family", async () => {
		const fetchImpl = makeFetch(() => modelsResponse(AURA_CATALOG));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", model: "aura", fetchImpl });
		expect(await provider.resolveDefaultVoice("en")).toBe("aura-asteria-en");
	});

	it("fetches the catalog once and serves later languages from the cache", async () => {
		let fetches = 0;
		const fetchImpl = makeFetch(() => {
			fetches += 1;
			return modelsResponse(AURA_CATALOG);
		});
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		await provider.resolveDefaultVoice("de");
		await provider.resolveDefaultVoice("en");
		expect(fetches).toBe(1);
	});

	it("throws NoTtsVoiceForLanguageError when no family voice matches the language", async () => {
		const fetchImpl = makeFetch(() => modelsResponse(AURA_CATALOG));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		const err = await provider.resolveDefaultVoice("ja").then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof NoTtsVoiceForLanguageError)) {
			throw new Error(`expected NoTtsVoiceForLanguageError, got ${err}`);
		}
		expect(err.provider).toBe("deepgram");
		expect(err.language).toBe("ja");
	});

	it("throws MissingProviderCredentialError naming DEEPGRAM_API_KEY when the key is absent", async () => {
		const provider = createDeepgramTtsProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const synthErr = await provider.synthesize({ text: "x", voice: "v" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(synthErr instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${synthErr}`);
		}
		expect(synthErr.envVar).toBe("DEEPGRAM_API_KEY");
		await expect(provider.resolveDefaultVoice("de")).rejects.toBeInstanceOf(
			MissingProviderCredentialError,
		);
	});

	it("throws TtsProviderError on 4xx/5xx, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("payment required", { status: 402 }));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "v" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.provider).toBe("deepgram");
		expect(err.statusCode).toBe(402);
	});

	it("throws TtsProviderError when the models catalog request fails", async () => {
		const fetchImpl = makeFetch(() => new Response("boom", { status: 500 }));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		await expect(provider.resolveDefaultVoice("de")).rejects.toBeInstanceOf(TtsProviderError);
	});

	it("throws TtsProviderError on an odd-length pcm body", async () => {
		const fetchImpl = makeFetch(() => new Response(new Uint8Array([0, 1, 2]), { status: 200 }));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "v" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});

	it("throws TtsProviderError on an empty pcm body", async () => {
		const fetchImpl = makeFetch(() => new Response(new Uint8Array(0), { status: 200 }));
		const provider = createDeepgramTtsProvider({ apiKey: () => "dg", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "v" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});
});
