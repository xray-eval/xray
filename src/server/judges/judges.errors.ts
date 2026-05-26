export class JudgeError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "JudgeError";
	}
}

export class JudgeProviderError extends JudgeError {
	readonly provider: string;
	readonly statusCode: number | null;
	constructor(
		provider: string,
		message: string,
		statusCode: number | null = null,
		options?: ErrorOptions,
	) {
		super(`Judge provider "${provider}" failed: ${message}`, options);
		this.name = "JudgeProviderError";
		this.provider = provider;
		this.statusCode = statusCode;
	}
}

/**
 * The provider returned a 200 but its body didn't parse into the
 * `{score: int, reason: string}` contract the runner expects. Separate
 * from `JudgeProviderError` so the inspector can distinguish "the API was
 * down" from "the model returned garbage" — different fix actions.
 */
export class JudgeOutputParseError extends JudgeError {
	readonly provider: string;
	readonly rawBody: string;
	constructor(provider: string, rawBody: string, message: string, options?: ErrorOptions) {
		super(`Judge provider "${provider}" returned an unparseable body: ${message}`, options);
		this.name = "JudgeOutputParseError";
		this.provider = provider;
		this.rawBody = rawBody;
	}
}
