import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { AppRouter } from "./router/router.ts";
import { createAppRouter } from "./router/router.ts";

function createTestQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
}

/**
 * Render-helper wrapper for component tests that use TanStack Query. Each
 * call constructs a fresh `QueryClient` so cache state never leaks across
 * tests — opposite of `createQueryClient` (which we want long-lived in prod).
 * `retry: false` keeps tests deterministic; `gcTime: Infinity` would also
 * leak state, so leave it default.
 */
export function withQueryClient(ui: ReactNode): ReactNode {
	return <QueryClientProvider client={createTestQueryClient()}>{ui}</QueryClientProvider>;
}

export interface RenderWithRouterResult {
	router: AppRouter;
	queryClient: QueryClient;
	ui: ReactNode;
}

/**
 * Renders the full app router under memory history so tests assert against
 * `router.state.location.pathname` after navigating. Constructs its own
 * `QueryClient` per call — same isolation discipline as `withQueryClient`.
 */
export function renderWithRouter(
	options: { initialEntries?: string[] } = {},
): RenderWithRouterResult {
	const queryClient = createTestQueryClient();
	const history = createMemoryHistory({
		initialEntries: options.initialEntries ?? ["/"],
	});
	const router = createAppRouter({ history });
	return {
		router,
		queryClient,
		ui: (
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		),
	};
}
