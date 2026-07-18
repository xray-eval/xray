import { InvalidEnvError, loadEnv } from "./env.ts";
import { describe, expect, test } from "bun:test";

describe("loadEnv", () => {
	test("applies defaults when keys are missing", () => {
		expect(loadEnv({})).toEqual({
			PORT: 8080,
			HOST: "127.0.0.1",
			XRAY_DATA_DIR: "/data",
		});
	});

	test("parses PORT as integer and keeps HOST and XRAY_DATA_DIR", () => {
		expect(loadEnv({ PORT: "3000", HOST: "127.0.0.1", XRAY_DATA_DIR: "./data" })).toEqual({
			PORT: 3000,
			HOST: "127.0.0.1",
			XRAY_DATA_DIR: "./data",
		});
	});

	test("honors XRAY_AUDIO_ROOT when provided", () => {
		expect(loadEnv({ XRAY_AUDIO_ROOT: "/mnt/audio" })).toEqual({
			PORT: 8080,
			HOST: "127.0.0.1",
			XRAY_DATA_DIR: "/data",
			XRAY_AUDIO_ROOT: "/mnt/audio",
		});
	});

	test("throws InvalidEnvError on empty XRAY_DATA_DIR", () => {
		expect(() => loadEnv({ XRAY_DATA_DIR: "" })).toThrow(InvalidEnvError);
	});

	test("accepts the Mistral provider selectors and MISTRAL_API_KEY", () => {
		const env = loadEnv({
			MISTRAL_API_KEY: "mk-x",
			XRAY_TRANSCRIPTION_PROVIDER: "mistral-voxtral",
			XRAY_JUDGE_PROVIDER: "mistral",
		});
		expect(env.MISTRAL_API_KEY).toBe("mk-x");
		expect(env.XRAY_TRANSCRIPTION_PROVIDER).toBe("mistral-voxtral");
		expect(env.XRAY_JUDGE_PROVIDER).toBe("mistral");
	});

	test("accepts the TTS selector, model, and voice overrides", () => {
		const env = loadEnv({
			XRAY_TTS_PROVIDER: "mistral",
			XRAY_TTS_MODEL: "voxtral-mini-tts-2603",
			XRAY_TTS_VOICE: "en_paul_neutral",
		});
		expect(env.XRAY_TTS_PROVIDER).toBe("mistral");
		expect(env.XRAY_TTS_MODEL).toBe("voxtral-mini-tts-2603");
		expect(env.XRAY_TTS_VOICE).toBe("en_paul_neutral");
	});

	test("throws InvalidEnvError on an unknown TTS provider selector", () => {
		expect(() => loadEnv({ XRAY_TTS_PROVIDER: "elevenlabs" })).toThrow(InvalidEnvError);
	});

	test("throws InvalidEnvError on an unknown provider selector", () => {
		expect(() => loadEnv({ XRAY_TRANSCRIPTION_PROVIDER: "deepgram" })).toThrow(InvalidEnvError);
	});

	test("accepts the Bedrock judge selector, bearer token, and region", () => {
		const env = loadEnv({
			AWS_BEARER_TOKEN_BEDROCK: "bedrock-key",
			XRAY_BEDROCK_REGION: "eu-central-1",
			XRAY_JUDGE_PROVIDER: "bedrock",
		});
		expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("bedrock-key");
		expect(env.XRAY_BEDROCK_REGION).toBe("eu-central-1");
		expect(env.XRAY_JUDGE_PROVIDER).toBe("bedrock");
	});

	test("rejects bedrock as a transcription provider selector (judge-only)", () => {
		expect(() => loadEnv({ XRAY_TRANSCRIPTION_PROVIDER: "bedrock-nova" })).toThrow(InvalidEnvError);
	});

	test("accepts the Deepgram key and transcription selector", () => {
		const env = loadEnv({
			DEEPGRAM_API_KEY: "dg-key",
			XRAY_TRANSCRIPTION_PROVIDER: "deepgram-nova",
		});
		expect(env.DEEPGRAM_API_KEY).toBe("dg-key");
		expect(env.XRAY_TRANSCRIPTION_PROVIDER).toBe("deepgram-nova");
	});

	test("throws InvalidEnvError on empty DEEPGRAM_API_KEY", () => {
		expect(() => loadEnv({ DEEPGRAM_API_KEY: "" })).toThrow(InvalidEnvError);
	});

	test("accepts deepgram as a TTS provider selector", () => {
		expect(loadEnv({ XRAY_TTS_PROVIDER: "deepgram" }).XRAY_TTS_PROVIDER).toBe("deepgram");
	});

	test("rejects deepgram as a judge provider selector (no judge LLM)", () => {
		expect(() => loadEnv({ XRAY_JUDGE_PROVIDER: "deepgram" })).toThrow(InvalidEnvError);
		expect(() => loadEnv({ XRAY_JUDGE_PROVIDER: "deepgram-nova" })).toThrow(InvalidEnvError);
	});

	test("leaves XRAY_BEDROCK_REGION unset by default (providers fall back to us-east-1)", () => {
		expect(loadEnv({}).XRAY_BEDROCK_REGION).toBeUndefined();
	});

	test("throws InvalidEnvError on empty AWS_BEARER_TOKEN_BEDROCK", () => {
		expect(() => loadEnv({ AWS_BEARER_TOKEN_BEDROCK: "" })).toThrow(InvalidEnvError);
	});

	test("rejects bedrock as a TTS provider selector (no Bedrock TTS exists)", () => {
		expect(() => loadEnv({ XRAY_TTS_PROVIDER: "bedrock" })).toThrow(InvalidEnvError);
	});

	test("throws InvalidEnvError on empty MISTRAL_API_KEY", () => {
		expect(() => loadEnv({ MISTRAL_API_KEY: "" })).toThrow(InvalidEnvError);
	});

	test("throws InvalidEnvError on non-numeric PORT", () => {
		expect(() => loadEnv({ PORT: "not-a-number" })).toThrow(InvalidEnvError);
	});

	test("throws InvalidEnvError on out-of-range PORT", () => {
		expect(() => loadEnv({ PORT: "70000" })).toThrow(InvalidEnvError);
	});

	test("InvalidEnvError carries issues", () => {
		try {
			loadEnv({ PORT: "0" });
			throw new Error("loadEnv was expected to throw InvalidEnvError but returned");
		} catch (e) {
			if (!(e instanceof InvalidEnvError)) throw e;
			expect(e.issues.length).toBeGreaterThan(0);
		}
	});
});
