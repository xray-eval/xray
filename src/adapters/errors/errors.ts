import type { ProviderId } from "../types.ts";

export class AdapterError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		// Set explicitly per class — `new.target.name` would be mangled by minifiers.
		this.name = "AdapterError";
	}
}

export class DuplicateAdapterError extends AdapterError {
	readonly provider: ProviderId;

	constructor(provider: ProviderId) {
		super(`Adapter for provider "${provider}" is already registered`);
		this.name = "DuplicateAdapterError";
		this.provider = provider;
	}
}
