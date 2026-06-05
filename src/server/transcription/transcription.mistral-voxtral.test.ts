import { makeFetch } from "@/server/core/test-utils.ts";

import {
	MissingProviderCredentialError,
	TranscriptionProviderError,
} from "./transcription.errors.ts";
import { createMistralVoxtralProvider } from "./transcription.mistral-voxtral.ts";
import { describe, expect, it } from "bun:test";

function voxtralResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("createMistralVoxtralProvider", () => {
	it("posts a multipart request to /v1/audio/transcriptions with the pinned model + word timestamps", async () => {
		const observed: {
			url: string;
			auth: string;
			model: string;
			granularity: string | null;
			language: string | null;
		} = { url: "", auth: "", model: "", granularity: null, language: null };
		const fetchImpl = makeFetch(({ url, headers, body }) => {
			observed.url = url;
			observed.auth = headers.get("authorization") ?? "";
			if (body instanceof FormData) {
				observed.model = String(body.get("model") ?? "");
				const granularity = body.get("timestamp_granularities[]");
				observed.granularity = typeof granularity === "string" ? granularity : null;
				const lang = body.get("language");
				observed.language = typeof lang === "string" ? lang : null;
			}
			return voxtralResponse({
				model: "voxtral-mini-2602",
				text: "hi",
				language: null,
				segments: [],
			});
		});
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk-test", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0, 1, 2, 3, 4, 5, 6, 7]),
			sampleRate: 16_000,
		});
		expect(observed.url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(observed.auth).toBe("Bearer mk-test");
		// Pinned dated snapshot, not the floating `voxtral-mini-latest` alias.
		expect(observed.model).toBe("voxtral-mini-2602");
		expect(observed.granularity).toBe("word");
		expect(observed.language).toBeNull();
	});

	it("sends the language hint and omits timestamp granularities when a language is given", async () => {
		const observed: { granularity: string | null; language: string | null } = {
			granularity: null,
			language: null,
		};
		const fetchImpl = makeFetch(({ body }) => {
			if (body instanceof FormData) {
				const granularity = body.get("timestamp_granularities[]");
				observed.granularity = typeof granularity === "string" ? granularity : null;
				const lang = body.get("language");
				observed.language = typeof lang === "string" ? lang : null;
			}
			return voxtralResponse({
				model: "voxtral-mini-2602",
				text: "x",
				language: "en",
				segments: [],
			});
		});
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		await provider.transcribe({
			audio: new Int16Array([0, 0]),
			sampleRate: 16_000,
			language: "en",
		});
		expect(observed.language).toBe("en");
		expect(observed.granularity).toBeNull();
	});

	it("maps word-granularity segments to trimmed word timings and computes duration locally", async () => {
		const fetchImpl = makeFetch(() =>
			voxtralResponse({
				model: "voxtral-mini-2602",
				text: "Hello world,",
				language: null,
				segments: [
					{ text: "Hello", start: 0.0, end: 0.3, speaker_id: null, type: "transcription_segment" },
					{
						text: " world,",
						start: 0.4,
						end: 0.8,
						speaker_id: null,
						type: "transcription_segment",
					},
				],
			}),
		);
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		// 16_000 samples at 16kHz = exactly 1000ms, independent of what the
		// provider reports (the response carries no duration field).
		const result = await provider.transcribe({
			audio: new Int16Array(16_000),
			sampleRate: 16_000,
		});
		expect(result.text).toBe("Hello world,");
		expect(result.durationMs).toBe(1000);
		expect(result.words).toEqual([
			{ text: "Hello", startMs: 0, endMs: 300 },
			{ text: "world,", startMs: 400, endMs: 800 },
		]);
	});

	it("returns null words when segments are empty or missing", async () => {
		const fetchImpl = makeFetch(() =>
			voxtralResponse({ model: "voxtral-mini-2602", text: "x", language: null, segments: [] }),
		);
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		const result = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(result.words).toBeNull();

		const fetchNoSegments = makeFetch(() => voxtralResponse({ text: "y" }));
		const provider2 = createMistralVoxtralProvider({
			apiKey: () => "mk",
			fetchImpl: fetchNoSegments,
		});
		const result2 = await provider2.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		expect(result2.words).toBeNull();
	});

	it("passes the response language through when present", async () => {
		const fetchImpl = makeFetch(() =>
			voxtralResponse({
				model: "voxtral-mini-2602",
				text: "bonjour",
				language: "fr",
				segments: [],
			}),
		);
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		const result = await provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 });
		// Narrow before equality — the union with null trips bun:test's overload.
		if (result.language === null) throw new Error("expected language");
		expect(result.language).toBe("fr");
	});

	it("throws MissingProviderCredentialError naming MISTRAL_API_KEY when the apiKey resolver returns undefined", async () => {
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
		expect(err.provider).toBe("mistral-voxtral");
		expect(err.statusCode).toBe(429);
	});

	it("throws TranscriptionProviderError on a malformed JSON response", async () => {
		const fetchImpl = makeFetch(
			() =>
				new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
		);
		const provider = createMistralVoxtralProvider({ apiKey: () => "mk", fetchImpl });
		await expect(
			provider.transcribe({ audio: new Int16Array([0]), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(TranscriptionProviderError);
	});
});
