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

/**
 * Per-field rather than around the whole object, because router-core merges a
 * validator's output *over* the raw search (`{ ...parentSearch, ...validated }`).
 * A rejected value therefore has to come back as a key holding `undefined` to
 * overwrite the raw one — returning a smaller object strips nothing, and the
 * junk reaches the page. Falling back to `undefined` rather than to a concrete
 * default also keeps the key absent when the URL omits it, so generated `<Link>`
 * hrefs don't accumulate `?replays=latest&scope=union`.
 *
 * Every field needs this, including the plain strings: TanStack JSON-parses
 * search values, so `?ids=123` arrives as a number.
 */
function urlParam<TSchema extends v.GenericSchema>(schema: TSchema) {
	return v.fallback(v.optional(schema), undefined);
}

export const CompareSearchSchema = v.object({
	ids: urlParam(v.string()),
});
export type CompareSearch = v.InferOutput<typeof CompareSearchSchema>;

// Config comparison state lives in the URL so a comparison is shareable:
// which configs, over which replays, across which conversations.
export const ConfigsSearchSchema = v.object({
	ids: urlParam(v.string()),
	replays: urlParam(ReplaySelectionSchema),
	scope: urlParam(ConversationScopeSchema),
});
export type ConfigsSearch = v.InferOutput<typeof ConfigsSearchSchema>;

export const ConfigDetailSearchSchema = v.object({
	replays: urlParam(ReplaySelectionSchema),
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
	validateSearch: (search): CompareSearch => v.parse(CompareSearchSchema, search),
});

export const runConfigsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/configs",
	component: RunConfigsCompare,
	// `v.parse` rather than `safeParse`: every field is wrapped in `urlParam`, so
	// the schema is total and has no failure branch to handle. `router.test.ts`
	// pins that — a field added without `urlParam` fails there rather than
	// throwing at a user who pasted a stale link.
	validateSearch: (search): ConfigsSearch => v.parse(ConfigsSearchSchema, search),
});

export const runConfigDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/configs/$configHash",
	component: RunConfigDetail,
	validateSearch: (search): ConfigDetailSearch => v.parse(ConfigDetailSearchSchema, search),
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
