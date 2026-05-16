import { DuplicateAdapterError } from "./errors/errors.ts";
import type { ProviderId, VoiceAgentAdapter } from "./types.ts";

export interface AdapterRegistry {
	register(adapter: VoiceAgentAdapter): void;
	get(provider: ProviderId): VoiceAgentAdapter | undefined;
	list(): VoiceAgentAdapter[];
}

/**
 * Constructs a fresh registry. Each call produces an independent instance —
 * tests build one per test, the server builds one at startup. No module-level
 * mutable state, no `_clearRegistryForTests` escape hatch.
 */
export function createRegistry(): AdapterRegistry {
	const adapters = new Map<ProviderId, VoiceAgentAdapter>();
	return {
		register(adapter) {
			// Reject double-registration — silent overwrite would hide which copy is winning.
			if (adapters.has(adapter.provider)) {
				throw new DuplicateAdapterError(adapter.provider);
			}
			adapters.set(adapter.provider, adapter);
		},
		get(provider) {
			return adapters.get(provider);
		},
		list() {
			return Array.from(adapters.values());
		},
	};
}
