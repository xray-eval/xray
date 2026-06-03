import { makeFetch } from "@/server/core/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";

import { TtsProviderError } from "./tts.errors.ts";
import { createGoogleGeminiTtsProvider } from "./tts.google-gemini.ts";
import { describe, expect, it } from "bun:test";

function inlineAudioResponse(
	samples: number[],
	mimeType = "audio/L16;codec=pcm;rate=24000",
): Response {
	const pcm = new Int16Array(samples);
	const data = Buffer.from(new Uint8Array(pcm.buffer.slice(0))).toString("base64");
	return new Response(
		JSON.stringify({
			candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("createGoogleGeminiTtsProvider", () => {
	it("posts to generateContent with the AUDIO modality, voice config, and x-goog-api-key auth", async () => {
		let observedUrl = "";
		let observedKey = "";
		let observedBody = "";
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observedUrl = url;
			observedKey = headers.get("x-goog-api-key") ?? "";
			observedBody = JSON.stringify(body);
			return inlineAudioResponse([0, 1]);
		});
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => "AIza-test", fetchImpl });
		await provider.synthesize({ text: "hello", voice: "Kore" });
		expect(observedUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
		);
		expect(observedKey).toBe("AIza-test");
		expect(observedBody).toContain('"responseModalities":["AUDIO"]');
		expect(observedBody).toContain('"voiceName":"Kore"');
		expect(observedBody).toContain("hello");
	});

	it("decodes base64 inline pcm at the rate declared in the mimeType", async () => {
		const fetchImpl = makeFetch(() =>
			inlineAudioResponse([0, 250, -250], "audio/L16;codec=pcm;rate=24000"),
		);
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => "k", fetchImpl });
		const result = await provider.synthesize({ text: "x", voice: "Kore" });
		expect(result.sampleRate).toBe(24_000);
		expect([...result.pcm]).toEqual([0, 250, -250]);
	});

	it("exposes name, default model, and default voice", () => {
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => "k", fetchImpl: fetch });
		expect(provider.name).toBe("google-gemini");
		expect(provider.model).toBe("gemini-2.5-flash-preview-tts");
		expect(provider.defaultVoice).toBe("Kore");
	});

	it("throws MissingProviderCredentialError naming GOOGLE_API_KEY when the key is absent", async () => {
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => undefined, fetchImpl: fetch });
		const err = await provider.synthesize({ text: "x", voice: "Kore" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof MissingProviderCredentialError)) {
			throw new Error(`expected MissingProviderCredentialError, got ${err}`);
		}
		expect(err.envVar).toBe("GOOGLE_API_KEY");
	});

	it("throws TtsProviderError on 4xx/5xx, preserving the status code", async () => {
		const fetchImpl = makeFetch(() => new Response("denied", { status: 403 }));
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => "k", fetchImpl });
		const err = await provider.synthesize({ text: "x", voice: "Kore" }).then(
			() => null,
			(e: unknown) => e,
		);
		if (!(err instanceof TtsProviderError)) {
			throw new Error(`expected TtsProviderError, got ${err}`);
		}
		expect(err.provider).toBe("google-gemini");
		expect(err.statusCode).toBe(403);
	});

	it("throws TtsProviderError when the response carries no inline audio part", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(
					JSON.stringify({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => "k", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "Kore" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});

	it("throws TtsProviderError when the prompt is blocked by the safety filter", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = createGoogleGeminiTtsProvider({ apiKey: () => "k", fetchImpl });
		await expect(provider.synthesize({ text: "x", voice: "Kore" })).rejects.toBeInstanceOf(
			TtsProviderError,
		);
	});
});
