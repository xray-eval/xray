export class TtsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TtsError";
	}
}

/**
 * The provider rejected the synthesis request — network error, 4xx/5xx
 * from the upstream API, malformed response body. Wraps the underlying
 * cause so a debugger can pull the stack chain.
 */
export class TtsProviderError extends TtsError {
	readonly provider: string;
	readonly statusCode: number | null;
	constructor(
		provider: string,
		message: string,
		statusCode: number | null = null,
		options?: ErrorOptions,
	) {
		super(`TTS provider "${provider}" failed: ${message}`, options);
		this.name = "TtsProviderError";
		this.provider = provider;
		this.statusCode = statusCode;
	}
}
