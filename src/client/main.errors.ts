export class BootError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BootError";
	}
}

export class MissingRootElementError extends BootError {
	constructor() {
		super("Root element '#root' missing from index.html");
		this.name = "MissingRootElementError";
	}
}
