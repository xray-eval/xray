import type { RouterHistory } from "@tanstack/react-router";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import * as v from "valibot";

import {
	ConversationScopeSchema,
	ReplaySelectionSchema,
} from "@/server/run-configs/run-configs.types.ts";

import { CompareConversations } from "../conversations/compare-conversations.tsx";
import { ConversationDetail } from "../conversations/conversation-detail.tsx";
import { ConversationsList } from "../conversations/conversations.tsx";
import { Inspector } from "../inspector/inspector.tsx";
import { CompareReplays } from "../replays/compare.tsx";
import { RunConfigDetail } from "../run-configs/run-config-detail.tsx";
import { RunConfigsCompare } from "../run-configs/run-configs-compare.tsx";
import { NotFoundView } from "./not-found.tsx";
import { RootLayout } from "./root-layout.tsx";

const CompareSearchSchema = v.object({
	ids: v.optional(v.string()),
});
export type CompareSearch = v.InferOutput<typeof CompareSearchSchema>;

// Config comparison state lives in the URL so a comparison is shareable:
// which configs, over which replays, across which conversations.
const ConfigsSearchSchema = v.object({
	ids: v.optional(v.string()),
	replays: v.optional(ReplaySelectionSchema),
	scope: v.optional(ConversationScopeSchema),
});
export type ConfigsSearch = v.InferOutput<typeof ConfigsSearchSchema>;

const ConfigDetailSearchSchema = v.object({
	replays: v.optional(ReplaySelectionSchema),
});
export type ConfigDetailSearch = v.InferOutput<typeof ConfigDetailSearchSchema>;

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
	path: "/conversations/$conversationHash",
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

export const runConfigsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/configs",
	component: RunConfigsCompare,
	// Tolerant parse: a hand-edited or stale search param degrades to defaults
	// rather than crashing the page a user just pasted a link to.
	validateSearch: (search): ConfigsSearch => {
		const parsed = v.safeParse(ConfigsSearchSchema, search);
		return parsed.success ? parsed.output : {};
	},
});

export const runConfigDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/configs/$configHash",
	component: RunConfigDetail,
	validateSearch: (search): ConfigDetailSearch => {
		const parsed = v.safeParse(ConfigDetailSearchSchema, search);
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
	runConfigsRoute,
	runConfigDetailRoute,
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
