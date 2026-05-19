import type { RouterHistory } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import * as v from "valibot";

import { CompareConversations } from "../conversations/compare-conversations.tsx";
import { ConversationDetail } from "../conversations/conversation-detail.tsx";
import { ConversationsList } from "../conversations/conversations.tsx";
import { Inspector } from "../inspector/inspector.tsx";
import { CompareReplays } from "../replays/compare.tsx";
import { NotFoundView } from "./not-found.tsx";
import { RootLayout } from "./root-layout.tsx";

const CompareSearchSchema = v.object({
	ids: v.optional(v.string()),
});
export type CompareSearch = v.InferOutput<typeof CompareSearchSchema>;

export const rootRoute = createRootRoute({
	component: RootLayout,
	notFoundComponent: NotFoundView,
});

export const conversationsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: ConversationsList,
});

export const conversationDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/conversations/$conversationId",
	component: ConversationDetail,
});

export const replayRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/replays/$replayId",
	component: Inspector,
});

export const compareReplaysRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/compare/replays",
	component: CompareReplays,
	validateSearch: (search): CompareSearch => {
		const parsed = v.safeParse(CompareSearchSchema, search);
		return parsed.success ? parsed.output : {};
	},
});

export const compareConversationsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/compare/conversations",
	component: CompareConversations,
	validateSearch: (search): CompareSearch => v.parse(CompareSearchSchema, search),
});

const routeTree = rootRoute.addChildren([
	conversationsRoute,
	conversationDetailRoute,
	replayRoute,
	compareReplaysRoute,
	compareConversationsRoute,
]);

export interface CreateAppRouterOptions {
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
