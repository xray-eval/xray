import { QueryClient } from "@tanstack/react-query";

/**
 * Single shared QueryClient. Defaults tuned for a self-hosted single-user
 * debugger: long staleTime so the same session list isn't refetched on every
 * mount, and no retry — a real server failure should surface to the user
 * immediately rather than mask a broken endpoint behind silent retries.
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
