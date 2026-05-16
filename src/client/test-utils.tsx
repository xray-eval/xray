import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Render-helper wrapper for component tests that use TanStack Query. Each
 * call constructs a fresh `QueryClient` so cache state never leaks across
 * tests — opposite of `createQueryClient` (which we want long-lived in prod).
 * `retry: false` keeps tests deterministic; `gcTime: Infinity` would also
 * leak state, so leave it default.
 */
export function withQueryClient(ui: ReactNode): ReactNode {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}
