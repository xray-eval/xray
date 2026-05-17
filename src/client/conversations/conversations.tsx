import type { InfiniteData } from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronRight, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { match } from "ts-pattern";

import type { ListSessionsResponse, SessionListItem } from "@/server/sessions/sessions.types.ts";

import { fetchSessions } from "../api/sessions-api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { formatAbsolute, formatDuration } from "../format.ts";
import { sourceBadgeVariant } from "../source-badge.ts";

export interface ConversationsListProps {
	/** Optional `agentId` filter passed through as `?agentId=` to the server. */
	agentId?: string;
	/**
	 * API base URL override. Defaults to `window.location.origin` (set inside
	 * `fetchSessions`). Tests pass `http://localhost` so happy-dom can resolve
	 * the relative path.
	 */
	apiBase?: string;
	/** Called with the row's session id when the user clicks one. */
	onSelectSession?: (sessionId: string) => void;
}

type SessionsQueryKey = readonly ["sessions", { agentId: string | undefined }];

export function ConversationsList({ agentId, apiBase, onSelectSession }: ConversationsListProps) {
	const query = useInfiniteQuery<
		ListSessionsResponse,
		Error,
		InfiniteData<ListSessionsResponse>,
		SessionsQueryKey,
		string | undefined
	>({
		queryKey: ["sessions", { agentId }] as const,
		queryFn: ({ pageParam, signal }) =>
			fetchSessions({
				signal,
				...(agentId !== undefined ? { agentId } : {}),
				...(pageParam !== undefined ? { cursor: pageParam } : {}),
				...(apiBase !== undefined ? { apiBase } : {}),
			}),
		initialPageParam: undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	return (
		<section aria-label="Conversations" aria-busy={query.isPending} className="space-y-6">
			<header className="flex items-baseline justify-between gap-4">
				<h2 className="text-2xl font-semibold tracking-tight">Conversations</h2>
				<SessionCount query={query} />
			</header>

			{match(query)
				.with({ status: "pending" }, () => <LoadingState />)
				.with({ status: "error" }, (q) => (
					<ErrorState error={q.error} onRetry={() => query.refetch()} />
				))
				.with({ status: "success" }, (q) => {
					const items = q.data.pages.flatMap((p) => p.sessions);
					if (items.length === 0) return <EmptyState />;
					return (
						<div className="space-y-3">
							<ul className="space-y-3">
								{items.map((item) => (
									<ConversationRow
										key={item.id}
										session={item}
										{...(onSelectSession !== undefined ? { onSelect: onSelectSession } : {})}
									/>
								))}
							</ul>
							{q.hasNextPage && (
								<div className="flex justify-center pt-2">
									<Button
										variant="outline"
										onClick={() => q.fetchNextPage()}
										disabled={q.isFetchingNextPage}
									>
										{q.isFetchingNextPage ? "Loading…" : "Load more"}
										<ChevronRight />
									</Button>
								</div>
							)}
						</div>
					);
				})
				.exhaustive()}
		</section>
	);
}

interface SessionCountProps {
	query: ReturnType<typeof useInfiniteQuery<ListSessionsResponse>>;
}

function SessionCount({ query }: SessionCountProps) {
	if (query.status !== "success") return null;
	const n = query.data.pages.reduce((sum, p) => sum + p.sessions.length, 0);
	const more = query.hasNextPage ? "+" : "";
	return (
		<span className="text-muted-foreground text-sm">
			{n}
			{more} session{n === 1 ? "" : "s"}
		</span>
	);
}

interface ConversationRowProps {
	session: SessionListItem;
	onSelect?: (sessionId: string) => void;
}

function ConversationRow({ session, onSelect }: ConversationRowProps) {
	const inner = (
		<Card className="group w-full text-left transition-colors hover:bg-accent/30">
			<CardHeader>
				<CardDescription>
					<time dateTime={session.startedAt}>{formatAbsolute(session.startedAt)}</time>
				</CardDescription>
				<CardTitle className="text-base font-medium">
					<dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
						<div className="flex items-baseline gap-2">
							<dt className="sr-only">Agent</dt>
							<dd>{session.agentId}</dd>
						</div>
						<div className="text-muted-foreground flex items-baseline gap-2 text-sm font-normal">
							<dt>Duration</dt>
							<dd>{formatDuration(session.durationMs)}</dd>
						</div>
						<div className="flex items-baseline gap-2 text-sm font-normal">
							<dt className="sr-only">Source</dt>
							<dd>
								<Badge variant={sourceBadgeVariant(session.source)}>{session.source}</Badge>
							</dd>
						</div>
					</dl>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex justify-end">
				<ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
			</CardContent>
		</Card>
	);
	return (
		<li>
			{onSelect !== undefined ? (
				<button
					type="button"
					onClick={() => onSelect(session.id)}
					aria-label={`Open session ${session.agentId}, started ${formatAbsolute(session.startedAt)}`}
					className="block w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-xl"
				>
					{inner}
				</button>
			) : (
				inner
			)}
		</li>
	);
}

function LoadingState() {
	return (
		<ul className="space-y-3">
			{[0, 1, 2, 3].map((i) => (
				<li key={i}>
					<Card>
						<CardHeader>
							<Skeleton className="h-3 w-32" />
							<div className="flex items-center gap-6">
								<Skeleton className="h-4 w-40" />
								<Skeleton className="h-4 w-16" />
								<Skeleton className="h-4 w-24" />
							</div>
						</CardHeader>
					</Card>
				</li>
			))}
		</ul>
	);
}

interface ErrorStateProps {
	error: Error;
	onRetry: () => void;
}

function ErrorState({ error, onRetry }: ErrorStateProps) {
	return (
		<Card role="alert">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<AlertCircle className="text-destructive size-4" />
					Failed to load sessions.
				</CardTitle>
				<CardDescription className="break-all">{error.message}</CardDescription>
			</CardHeader>
			<CardContent className="flex justify-end">
				<Button size="sm" variant="outline" onClick={onRetry}>
					Try again
				</Button>
			</CardContent>
		</Card>
	);
}

function EmptyState() {
	return (
		<Card>
			<CardHeader className="items-center text-center">
				<CardTitle>No sessions yet.</CardTitle>
				<CardDescription>To populate the store:</CardDescription>
			</CardHeader>
			<CardContent className="text-muted-foreground space-y-3 text-sm">
				<EmptyHint>
					POST events from your voice-agent loop to <Code>/v1/sessions/:id/events</Code>.
				</EmptyHint>
				<EmptyHint>
					Run <Code>pnpm dev:seed</Code> to load JSONL fixtures.
				</EmptyHint>
				<EmptyHint>
					Or configure a provider adapter (e.g. <Code>ELEVENLABS_API_KEY</Code>
					).
				</EmptyHint>
				<div className="pt-3 text-center">
					<a
						href="https://github.com/basilebong/xray#readme"
						target="_blank"
						rel="noreferrer noopener"
						className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs"
					>
						Read the docs
						<ExternalLink className="size-3" />
					</a>
				</div>
			</CardContent>
		</Card>
	);
}

function EmptyHint({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-3">
			<span aria-hidden="true" className="bg-primary mt-2 size-1 shrink-0 rounded-full" />
			<span>{children}</span>
		</div>
	);
}

function Code({ children }: { children: ReactNode }) {
	return (
		<code className="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-[0.85em]">
			{children}
		</code>
	);
}
