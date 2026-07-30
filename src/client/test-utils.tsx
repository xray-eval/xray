import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
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

/**
 * Mount one component inside a memory router, for components that render a
 * `<Link>` but own no route of their own. `renderWithRouter` boots the whole
 * app and navigates to a URL — the right tool for a page, but it drags in that
 * page's queries and MSW handlers when all you want is to hand a component a
 * prop and read the markup back.
 *
 * Uses a catch-all route so any `to=` the component links to resolves.
 */
export function withRouter(ui: ReactNode): ReactNode {
	const rootRoute = createRootRoute({ component: () => <>{ui}</> });
	const splatRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "$",
		component: () => <>{ui}</>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([splatRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	return (
		<QueryClientProvider client={createTestQueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
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
