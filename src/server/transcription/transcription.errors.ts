export class TranscriptionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TranscriptionError";
	}
}

/**
 * The provider rejected the request — network error, 4xx/5xx from the
 * upstream API, malformed response body. Wraps the underlying cause so a
 * debugger can pull the stack chain.
 */
export class TranscriptionProviderError extends TranscriptionError {
	readonly provider: string;
	readonly statusCode: number | null;
	constructor(
		provider: string,
		message: string,
		statusCode: number | null = null,
		options?: ErrorOptions,
	) {
		super(`Transcription provider "${provider}" failed: ${message}`, options);
		this.name = "TranscriptionProviderError";
		this.provider = provider;
		this.statusCode = statusCode;
	}
}

/**
 * A stage (transcription / judges) tried to call its provider but the env
 * never supplied the credential. Stamped against the replay's
 * `failure_reason` and surfaced over SSE — operators see "set OPENAI_API_KEY
 * and re-run" rather than a 500 with no signal.
 */
export class MissingProviderCredentialError extends TranscriptionError {
	readonly envVar: string;
	constructor(envVar: string) {
		super(
			`Missing provider credential — set the ${envVar} environment variable and restart the server`,
		);
		this.name = "MissingProviderCredentialError";
		this.envVar = envVar;
	}
}
