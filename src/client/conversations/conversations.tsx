import type { InfiniteData } from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ChevronRight, ExternalLink, Play } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../components/ui/table.tsx";
import { formatAbsolute, formatDuration } from "../format.ts";
import { ReplayModal } from "../replays/replay-modal.tsx";
import { sourceBadgeVariant } from "../source-badge.ts";

type SessionsQueryKey = readonly ["sessions", Record<string, never>];

export function ConversationsList() {
	const navigate = useNavigate();
	const [modalSource, setModalSource] = useState<string | null>(null);

	const query = useInfiniteQuery<
		ListSessionsResponse,
		Error,
		InfiniteData<ListSessionsResponse>,
		SessionsQueryKey,
		string | undefined
	>({
		queryKey: ["sessions", {}] as const,
		queryFn: ({ pageParam, signal }) =>
			fetchSessions({ signal, ...(pageParam !== undefined ? { cursor: pageParam } : {}) }),
		initialPageParam: undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	return (
		<>
			<section
				aria-labelledby="conversations-heading"
				aria-busy={query.isPending}
				className="space-y-6"
			>
				<header className="flex items-baseline justify-between gap-4">
					<h2 id="conversations-heading" className="text-2xl font-semibold tracking-tight">
						Conversations
					</h2>
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
								<ConversationsTable items={items} onReplay={(id) => setModalSource(id)} />
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
			{modalSource !== null && (
				<ReplayModal
					sourceSessionId={modalSource}
					onClose={() => setModalSource(null)}
					onStarted={(run) => {
						setModalSource(null);
						void navigate({ to: "/replays/$replayId", params: { replayId: run.id } });
					}}
				/>
			)}
		</>
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

interface ConversationsTableProps {
	items: readonly SessionListItem[];
	onReplay: (sessionId: string) => void;
}

function ConversationsTable({ items, onReplay }: ConversationsTableProps) {
	return (
		<Table>
			<ConversationsTableHead />
			<TableBody>
				{items.map((item) => (
					<ConversationRow key={item.id} session={item} onReplay={onReplay} />
				))}
			</TableBody>
		</Table>
	);
}

function ConversationsTableHead() {
	return (
		<TableHeader>
			<TableRow>
				<TableHead scope="col">Started</TableHead>
				<TableHead scope="col">Agent</TableHead>
				<TableHead scope="col">Duration</TableHead>
				<TableHead scope="col">Source</TableHead>
				<TableHead scope="col" className="w-px text-right">
					<span className="sr-only">Actions</span>
				</TableHead>
			</TableRow>
		</TableHeader>
	);
}

interface ConversationRowProps {
	session: SessionListItem;
	onReplay: (sessionId: string) => void;
}

function ConversationRow({ session, onReplay }: ConversationRowProps) {
	// Wrapping <tr> in an <a> is invalid HTML, so the agent-cell <Link> uses
	// `::after` to cover the whole row; the Replay cell sits in its own
	// stacking context so the button stays clickable above the overlay.
	return (
		<TableRow className="relative">
			<TableCell className="text-muted-foreground">
				<time dateTime={session.startedAt}>{formatAbsolute(session.startedAt)}</time>
			</TableCell>
			<TableCell className="font-medium">
				<Link
					to="/sessions/$sessionId"
					params={{ sessionId: session.id }}
					aria-label={`Open session ${session.agentId}, started ${formatAbsolute(session.startedAt)}`}
					className="after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
				>
					{session.agentId}
				</Link>
			</TableCell>
			<TableCell className="text-muted-foreground">{formatDuration(session.durationMs)}</TableCell>
			<TableCell>
				<Badge variant={sourceBadgeVariant(session.source)}>{session.source}</Badge>
			</TableCell>
			<TableCell className="relative z-10 text-right">
				<Button
					variant="outline"
					size="sm"
					onClick={() => onReplay(session.id)}
					aria-label={`Replay session ${session.agentId}`}
				>
					<Play />
					Replay
				</Button>
			</TableCell>
		</TableRow>
	);
}

function LoadingState() {
	return (
		<Table>
			<ConversationsTableHead />
			<TableBody>
				{[0, 1, 2, 3].map((i) => (
					<TableRow key={i}>
						<TableCell>
							<Skeleton className="h-4 w-32" />
						</TableCell>
						<TableCell>
							<Skeleton className="h-4 w-40" />
						</TableCell>
						<TableCell>
							<Skeleton className="h-4 w-16" />
						</TableCell>
						<TableCell>
							<Skeleton className="h-5 w-20 rounded-full" />
						</TableCell>
						<TableCell className="text-right">
							<Skeleton className="ml-auto h-8 w-20" />
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
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
						href="https://github.com/xray-eval/xray#readme"
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
