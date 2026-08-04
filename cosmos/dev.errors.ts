export class CosmosDevError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CosmosDevError";
	}
}

export class RendererUrlError extends CosmosDevError {
	readonly rendererUrl: string;
	constructor(rendererUrl: string) {
		super(
			`cosmos.config.json "rendererUrl" must be an absolute URL with an explicit port, got "${rendererUrl}"`,
		);
		this.name = "RendererUrlError";
		this.rendererUrl = rendererUrl;
	}
}

export class CosmosImportsTimeoutError extends CosmosDevError {
	readonly importsPath: string;
	readonly timeoutMs: number;
	constructor(importsPath: string, timeoutMs: number) {
		super(
			`Cosmos did not generate "${importsPath}" within ${timeoutMs}ms — check the cosmos output above for a config or fixture-scan error`,
		);
		this.name = "CosmosImportsTimeoutError";
		this.importsPath = importsPath;
		this.timeoutMs = timeoutMs;
	}
}
