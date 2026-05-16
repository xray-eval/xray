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
	HOST: v.optional(v.string(), "0.0.0.0"),
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
