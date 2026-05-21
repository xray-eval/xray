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
