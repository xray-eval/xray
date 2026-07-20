import * as v from "valibot";

import { writeMonoWav } from "@/server/audio/audio.wav.ts";
import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { NoTtsVoiceForLanguageError, TtsProviderError } from "./tts.errors.ts";
import { createMistralTtsProvider } from "./tts.mistral.ts";
import { describe, expect, it } from "bun:test";

const SpeechBodySchema = v.object({
	model: v.optional(v.unknown()),
	input: v.optional(v.unknown()),
	voice_id: v.optional(v.unknown()),
	response_format: v.optional(v.unknown()),
});
type SpeechBody = v.InferOutput<typeof SpeechBodySchema>;

function asSpeechBody(value: unknown): SpeechBody | null {
	const result = v.safeParse(SpeechBodySchema, value);
	return result.success ? result.output : null;
}

function wavJsonResponse(samples: number[], sampleRate = 24_000): Response {
	const wavBytes = writeMonoWav(new Int16Array(samples), sampleRate);
	const audioData = Buffer.from(wavBytes).toString("base64");
	return new Response(JSON.stringify({ audio_data: audioData }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createMistralTtsProvider", () => {
	it("posts to /v1/audio/speech with the pinned model, wav format, and the requested voice_id", async () => {
		let observedUrl = "";
		let observedAuth = "";
		let observedBody: SpeechBody = {};
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedAuth = headers.get("authorization") ?? "";
			const parsed = asSpeechBody(body);
			if (parsed !== null) observedBody = parsed;
			return wavJsonResponse([0, 1, 2]);
		});
		const provider = createMistralTtsProvider({ apiKey: () => "mk-test", fetchImpl });
		await provider.synthesize({ text: "hello", voice: "en_paul_neutral" });
		expect(observedUrl).toBe("https://api.mistral.ai/v1/audio/speech");
		expect(observedAuth).toBe("Bearer mk-test");
		expect(observedBody.model).toBe("voxtral-mini-tts-2603");
		expect(observedBody.input).toBe("hello");
		expect(observedBody.voice_id).toBe("en_paul_neutral");
		expect(observedBody.response_format).toBe("wav");
	});

	it("decodes the base64 wav in audio_data, returning pcm at the wav's declared rate", async () => {
		const fetchImpl = makeFetch(() => wavJsonResponse([0, 500, -500, 12345], 24_000));
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		const result = await provider.synthesize({ text: "x", voice: "en_paul_neutral" });
		expect(result.sampleRate).toBe(24_000);
		expect([...result.pcm]).toEqual([0, 500, -500, 12345]);
	});

	it("exposes name, pinned default model, and default voice", async () => {
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl: fetch });
		expect(provider.name).toBe("mistral");
		expect(provider.model).toBe("voxtral-mini-tts-2603");
		expect(await provider.resolveDefaultVoice()).toBe("en_paul_neutral");
	});

	it("throws MissingProviderCredentialError naming MISTRAL_API_KEY when the key is absent", async () => {
		const provider = createMistralTtsProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.synthesize({ text: "x", voice: "v" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("MISTRAL_API_KEY");
	});

	it("throws TtsProviderError on 4xx/5xx, preserving the status code", async () => {
		const fetchImpl = makeFetch(
			() => new Response(JSON.stringify({ object: "error" }), { status: 404 }),
		);
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "bad-voice" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.provider).toBe("mistral");
		expect(err.statusCode).toBe(404);
	});

	it("throws TtsProviderError when audio_data is not valid base64 wav", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ audio_data: "bm90IGEgd2F2" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "v" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});

	it("throws TtsProviderError when the response body is missing audio_data", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ something: "else" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "v" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});
});

function catalogVoice(voice: {
	id: string;
	slug?: string | null;
	languages: string[];
	created_at?: string;
}): Record<string, unknown> {
	return { slug: null, created_at: "2026-01-01T00:00:00Z", ...voice };
}

function catalogResponse(items: Record<string, unknown>[], total?: number): Response {
	return new Response(JSON.stringify({ items, total: total ?? items.length }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createMistralTtsProvider resolveDefaultVoice", () => {
	const failingFetch = makeFetch(() => {
		throw new Error("unexpected network call");
	});

	it("resolves built-in preset languages statically, without hitting the catalog", async () => {
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl: failingFetch });
		expect(await provider.resolveDefaultVoice()).toBe("en_paul_neutral");
		expect(await provider.resolveDefaultVoice("en")).toBe("en_paul_neutral");
		expect(await provider.resolveDefaultVoice("en_us")).toBe("en_paul_neutral");
		expect(await provider.resolveDefaultVoice("en_gb")).toBe("gb_oliver_neutral");
		expect(await provider.resolveDefaultVoice("fr")).toBe("fr_marie_neutral");
		expect(await provider.resolveDefaultVoice("fr_fr")).toBe("fr_marie_neutral");
	});

	it("looks up a non-preset language in the voice catalog and picks the oldest matching custom voice", async () => {
		let observedUrl = "";
		const fetchImpl = makeFetch(({ url }) => {
			observedUrl = url;
			return catalogResponse([
				catalogVoice({ id: "uuid-newer", languages: ["de"], created_at: "2026-07-15T00:00:00Z" }),
				catalogVoice({ id: "uuid-older", languages: ["de"], created_at: "2026-07-14T00:00:00Z" }),
				catalogVoice({ id: "x", slug: "en_paul_neutral", languages: ["en_us"] }),
			]);
		});
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		expect(await provider.resolveDefaultVoice("de")).toBe("uuid-older");
		expect(observedUrl).toContain("/v1/audio/voices");
	});

	it("prefers a preset slug over a custom clone when both match the language", async () => {
		const fetchImpl = makeFetch(() =>
			catalogResponse([
				catalogVoice({ id: "uuid-custom", languages: ["es"], created_at: "2026-01-01T00:00:00Z" }),
				catalogVoice({ id: "y", slug: "es_lucia_neutral", languages: ["es_es"] }),
			]),
		);
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		expect(await provider.resolveDefaultVoice("es")).toBe("es_lucia_neutral");
	});

	it("prefers an exact regional match over a primary-subtag match", async () => {
		const fetchImpl = makeFetch(() =>
			catalogResponse([
				catalogVoice({ id: "uuid-pt", languages: ["pt"] }),
				catalogVoice({ id: "uuid-pt-br", languages: ["pt_br"] }),
			]),
		);
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		expect(await provider.resolveDefaultVoice("pt_br")).toBe("uuid-pt-br");
	});

	it("fetches the catalog once and serves later languages from the cache", async () => {
		let fetches = 0;
		const fetchImpl = makeFetch(() => {
			fetches += 1;
			return catalogResponse([
				catalogVoice({ id: "uuid-de", languages: ["de"] }),
				catalogVoice({ id: "uuid-it", languages: ["it"] }),
			]);
		});
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		expect(await provider.resolveDefaultVoice("de")).toBe("uuid-de");
		expect(await provider.resolveDefaultVoice("it")).toBe("uuid-it");
		expect(fetches).toBe(1);
	});

	it("paginates with limit/offset until the reported total is collected", async () => {
		const offsets: string[] = [];
		const fetchImpl = makeFetch(({ url }) => {
			const parsed = new URL(url);
			offsets.push(parsed.searchParams.get("offset") ?? "0");
			if (parsed.searchParams.get("offset") === "1") {
				return catalogResponse([catalogVoice({ id: "uuid-de", languages: ["de"] })], 2);
			}
			return catalogResponse([catalogVoice({ id: "uuid-en", languages: ["en_us"] })], 2);
		});
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		expect(await provider.resolveDefaultVoice("de")).toBe("uuid-de");
		expect(offsets).toEqual(["0", "1"]);
	});

	it("throws NoTtsVoiceForLanguageError when no catalog voice matches the language", async () => {
		const fetchImpl = makeFetch(() =>
			catalogResponse([catalogVoice({ id: "uuid-de", languages: ["de"] })]),
		);
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		const err = await provider.resolveDefaultVoice("ja").then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof NoTtsVoiceForLanguageError)) {
			throw new Error(`expected NoTtsVoiceForLanguageError, got ${err}`);
		}
		expect(err.language).toBe("ja");
	});

	it("throws MissingProviderCredentialError when the catalog is needed but no key is set", async () => {
		const provider = createMistralTtsProvider({ apiKey: () => undefined, fetchImpl: failingFetch });
		await expect(provider.resolveDefaultVoice("de")).rejects.toBeInstanceOf(
			MissingProviderCredentialError,
		);
	});

	it("throws TtsProviderError when the catalog request fails", async () => {
		const fetchImpl = makeFetch(() => new Response("boom", { status: 500 }));
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl });
		await expect(provider.resolveDefaultVoice("de")).rejects.toBeInstanceOf(TtsProviderError);
	});
});
