import { QueryClient } from "@tanstack/react-query";

/**
 * Defaults tuned for a self-hosted single-user debugger: long staleTime so the
 * same session list isn't refetched on every mount, and no retry — a real
 * server failure should surface immediately rather than hide behind retries.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: false,
				refetchOnWindowFocus: false,
			},
		},
	});
}
