export class ProviderConfigError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProviderConfigError";
	}
}

/**
 * Both `OPENAI_API_KEY` and `GOOGLE_API_KEY` are set but the per-stage
 * selector (`XRAY_TRANSCRIPTION_PROVIDER` / `XRAY_JUDGE_PROVIDER`) is
 * unset, so the inferred-provider rule can't pick one. Thrown at boot —
 * silently defaulting would hide which provider the operator meant to
 * run, so we fail loudly with the selector name to set.
 */
export class AmbiguousProviderConfigError extends ProviderConfigError {
	readonly selectorEnvVar: string;
	constructor(selectorEnvVar: string) {
		super(
			`Both OPENAI_API_KEY and GOOGLE_API_KEY are set — set ${selectorEnvVar} to pick one explicitly`,
		);
		this.name = "AmbiguousProviderConfigError";
		this.selectorEnvVar = selectorEnvVar;
	}
}
