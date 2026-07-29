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
