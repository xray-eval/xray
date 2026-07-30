import type { BaseIssue } from "valibot";

export class RunConfigError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		// Set explicitly per class — new.target.name would be mangled by minifiers.
		this.name = "RunConfigError";
	}
}

export class RunConfigNotFoundError extends RunConfigError {
	readonly configHash: string;
	constructor(configHash: string) {
		super(`Run config group "${configHash}" not found`);
		this.name = "RunConfigNotFoundError";
		this.configHash = configHash;
	}
}

/**
 * A `run_config` holding something JSON cannot round-trip (NaN, ±Infinity,
 * bigint, a function). `run_config` is `v.unknown()` at the wire boundary on
 * purpose — it's an opaque blob the dev owns — so the canonicalizer is the
 * first thing that inspects it, and `1e999` is valid JSON that parses to
 * Infinity. That makes this a caller's bad input, which a route maps to 400;
 * a bare `TypeError` would fall through to the catch-all and answer 500.
 */
export class UnhashableRunConfigError extends RunConfigError {
	/** What could not be encoded, safe to return to the caller. */
	readonly valueDescription: string;
	constructor(valueDescription: string) {
		super(`Run config contains a value JSON cannot represent: ${valueDescription}`);
		this.name = "UnhashableRunConfigError";
		this.valueDescription = valueDescription;
	}
}

export class InvalidRunConfigHashError extends RunConfigError {
	readonly issues: readonly BaseIssue<unknown>[];
	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Run config hash failed validation");
		this.name = "InvalidRunConfigHashError";
		this.issues = issues;
	}
}

export class InvalidRunConfigRequestError extends RunConfigError {
	readonly issues: readonly BaseIssue<unknown>[];
	constructor(issues: readonly BaseIssue<unknown>[]) {
		super("Run config request failed validation");
		this.name = "InvalidRunConfigRequestError";
		this.issues = issues;
	}
}

export class MalformedRunConfigBodyError extends RunConfigError {
	readonly issues: readonly BaseIssue<unknown>[] = [];
	constructor(options?: ErrorOptions) {
		super("Request body is not valid JSON", options);
		this.name = "MalformedRunConfigBodyError";
	}
}

export class RunConfigBodyTooLargeError extends RunConfigError {
	readonly maxBytes: number;
	constructor(maxBytes: number) {
		super(`Request body exceeded ${maxBytes} bytes`);
		this.name = "RunConfigBodyTooLargeError";
		this.maxBytes = maxBytes;
	}
}
