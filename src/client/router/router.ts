import type { RouterHistory } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import * as v from "valibot";

import { ConversationsList } from "../conversations/conversations.tsx";
import { Inspector } from "../inspector/inspector.tsx";
import { ReplayView } from "../replays/replay-view.tsx";
import { NotFoundView } from "./not-found.tsx";
import { RootLayout } from "./root-layout.tsx";

export const INSPECTOR_TABS = ["transcript", "replays"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const InspectorSearchSchema = v.object({
	tab: v.optional(v.picklist(INSPECTOR_TABS)),
});

export type InspectorSearch = v.InferOutput<typeof InspectorSearchSchema>;

export const rootRoute = createRootRoute({
	component: RootLayout,
	notFoundComponent: NotFoundView,
});

export const listRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: ConversationsList,
});

export const inspectorRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/sessions/$sessionId",
	component: Inspector,
	validateSearch: (search): InspectorSearch => v.parse(InspectorSearchSchema, search),
});

export const replayRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/replays/$replayId",
	component: ReplayView,
});

const routeTree = rootRoute.addChildren([listRoute, inspectorRoute, replayRoute]);

export interface CreateAppRouterOptions {
	/** Memory history for tests; omit in production to default to browser history. */
	history?: RouterHistory;
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
	return createRouter({
		routeTree,
		...(options.history !== undefined ? { history: options.history } : {}),
	});
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}
