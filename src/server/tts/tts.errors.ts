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

/**
 * A turn declared a language the provider has no voice for — neither a
 * built-in preset nor an org-cloned voice. Surfaced as a 4xx on the
 * conversation upsert so the operator learns the fix (clone a voice for
 * the language, or pick one explicitly) instead of getting an English
 * voice silently mispronouncing the text.
 */
export class NoTtsVoiceForLanguageError extends TtsError {
	readonly provider: string;
	readonly language: string;
	constructor(provider: string, language: string) {
		super(
			`TTS provider "${provider}" has no voice for language "${language}" — clone/upload a voice for that language, or set one explicitly via the turn's voice_id or XRAY_TTS_VOICE`,
		);
		this.name = "NoTtsVoiceForLanguageError";
		this.provider = provider;
		this.language = language;
	}
}
