import * as v from "valibot";

const EnvSchema = v.object({
	PORT: v.pipe(
		v.optional(v.string(), "8080"),
		v.transform(Number),
		v.number(),
		v.integer(),
		v.minValue(1),
		v.maxValue(65535),
	),
	// Default bind is loopback: the SDK→xray surface has no auth, so a wider
	// bind needs the operator's explicit opt-in (`HOST=0.0.0.0` + a fronting
	// proxy or shared-secret middleware). README documents this.
	HOST: v.optional(v.string(), "127.0.0.1"),
	// Directory holding the SQLite store file (`xray.db`). `/data` is the
	// mounted-volume convention in the production image; `./data` is the dev
	// equivalent at the repo root.
	XRAY_DATA_DIR: v.pipe(v.optional(v.string(), "/data"), v.nonEmpty()),
	// Audio root. Per-turn and full-replay audio files live here, indexed by
	// replay id. Defaults under XRAY_DATA_DIR if unset so a fresh `docker run`
	// works without operator intervention.
	XRAY_AUDIO_ROOT: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// bunqueue's own SQLite file (separate from xray.db — bunqueue opens its
	// own DB; see `.claude/rules/single-image-distribution.md` §4 for the
	// "one volume, two files" tradeoff). Defaults under XRAY_DATA_DIR.
	BUNQUEUE_DATA_PATH: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Provider credentials are read at call time by the transcription +
	// judge providers, not at boot — an operator running a smoke test
	// without any provider key should boot cleanly and only fail on the
	// first replay that hits a stage that needs the key.
	OPENAI_API_KEY: v.optional(v.pipe(v.string(), v.nonEmpty())),
	GOOGLE_API_KEY: v.optional(v.pipe(v.string(), v.nonEmpty())),
	MISTRAL_API_KEY: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Deepgram covers transcription (Nova) and TTS (Aura) — no judge (there
	// is no judge-capable LLM behind this key).
	DEEPGRAM_API_KEY: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Bedrock API key (bearer auth against bedrock-runtime — no SigV4, no
	// AWS SDK). The standard AWS-documented variable name, kept as-is so
	// operators can reuse a key they already export for other tooling.
	// Judge-only: Bedrock has no request/response TTS model and its only
	// audio-input chat models lag the providers we already ship.
	AWS_BEARER_TOKEN_BEDROCK: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Region of the bedrock-runtime endpoint the Bedrock judge calls.
	// Defaults to us-east-1 inside the provider when unset.
	XRAY_BEDROCK_REGION: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Selectors per stage. When unset, main.ts infers from which key is
	// present (exactly one provider key set → that provider, errors at boot
	// when several are set + selector unset — explicit beats ambiguous
	// default).
	XRAY_TRANSCRIPTION_PROVIDER: v.optional(
		v.picklist(["openai-whisper", "google-gemini", "mistral-voxtral", "deepgram-nova"]),
	),
	XRAY_JUDGE_PROVIDER: v.optional(v.picklist(["openai", "google-gemini", "mistral", "bedrock"])),
	// TTS runs during POST /v1/conversations (user-turn audio synthesis),
	// not in the analyze chain — but the selector follows the same pattern.
	XRAY_TTS_PROVIDER: v.optional(v.picklist(["openai", "google-gemini", "mistral", "deepgram"])),
	// Override the transcription model. Defaults to whisper-1 (OpenAI),
	// gemini-2.5-flash (Google), voxtral-small-2507 (Mistral), or nova-3
	// (Deepgram) inside the respective provider when unset.
	XRAY_TRANSCRIPTION_MODEL: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Override the judge LLM model. Defaults to gpt-4o-2024-08-06 (OpenAI),
	// gemini-3.5-flash (Google), mistral-medium-2604 (Mistral), or
	// global.anthropic.claude-opus-4-8 (Bedrock) inside the respective
	// provider when unset.
	XRAY_JUDGE_MODEL: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Override the TTS model. Defaults to gpt-4o-mini-tts (OpenAI),
	// gemini-2.5-flash-preview-tts (Google), voxtral-mini-tts-2603
	// (Mistral), or the aura-2 voice family (Deepgram — voice ids fold the
	// family in, so this override is the family prefix there) inside the
	// respective provider when unset.
	XRAY_TTS_MODEL: v.optional(v.pipe(v.string(), v.nonEmpty())),
	// Default voice for synthesized user turns. A turn's explicit `voice_id`
	// wins over this; this wins over the provider's built-in default.
	XRAY_TTS_VOICE: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

export type Env = v.InferOutput<typeof EnvSchema>;

export class InvalidEnvError extends Error {
	readonly issues: readonly v.BaseIssue<unknown>[];
	constructor(issues: readonly v.BaseIssue<unknown>[]) {
		super(`Invalid environment: ${issues.map((i) => i.message).join(", ")}`);
		this.name = "InvalidEnvError";
		this.issues = issues;
	}
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
	const result = v.safeParse(EnvSchema, source);
	if (!result.success) {
		throw new InvalidEnvError(result.issues);
	}
	return result.output;
}
