import * as v from "valibot";

import { writeMonoWav } from "@/server/audio/audio.wav.ts";
import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { TtsProviderError } from "./tts.errors.ts";
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

	it("exposes name, pinned default model, and default voice", () => {
		const provider = createMistralTtsProvider({ apiKey: () => "mk", fetchImpl: fetch });
		expect(provider.name).toBe("mistral");
		expect(provider.model).toBe("voxtral-mini-tts-2603");
		expect(provider.defaultVoice).toBe("en_paul_neutral");
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
