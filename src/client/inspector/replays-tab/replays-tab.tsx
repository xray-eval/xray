import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { match } from "ts-pattern";

import type { ListReplayRunsResponse, ReplayRunResponse } from "@/server/replays/replays.types.ts";

import { fetchReplaysForSession } from "../../api/replays-api.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../components/ui/card.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { formatAbsolute } from "../../format.ts";
import { ReplayStatusBadge } from "../../replays/replay-status-badge.tsx";

type ReplaysQueryKey = readonly ["replays", { sessionId: string }];

export function ReplaysTab({ sessionId }: { sessionId: string }) {
	const query = useQuery<ListReplayRunsResponse, Error, ListReplayRunsResponse, ReplaysQueryKey>({
		queryKey: ["replays", { sessionId }] as const,
		queryFn: ({ signal }) => fetchReplaysForSession({ sessionId, signal }),
	});

	return (
		<section
			aria-label="Replays"
			aria-busy={query.isPending}
			aria-live="polite"
			className="space-y-4"
		>
			{match(query)
				.with({ status: "pending" }, () => <LoadingState />)
				.with({ status: "error" }, (q) => (
					<ErrorState error={q.error} onRetry={() => query.refetch()} />
				))
				.with({ status: "success" }, (q) =>
					q.data.items.length === 0 ? <EmptyState /> : <ReplaysList items={q.data.items} />,
				)
				.exhaustive()}
		</section>
	);
}

function ReplaysList({ items }: { items: readonly ReplayRunResponse[] }) {
	return (
		<ol className="space-y-2">
			{items.map((run) => (
				<li key={run.id}>
					<ReplayRow run={run} />
				</li>
			))}
		</ol>
	);
}

function ReplayRow({ run }: { run: ReplayRunResponse }) {
	return (
		<Link
			to="/replays/$replayId"
			params={{ replayId: run.id }}
			aria-label={`Open replay ${run.id}`}
			className="block rounded-md border border-border bg-card p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
		>
			<div className="flex flex-wrap items-center gap-2">
				<ReplayStatusBadge status={run.status} />
				<Badge variant="outline" className="font-mono">
					{run.mode}
				</Badge>
				<span className="font-mono text-xs text-muted-foreground">{`${run.id.slice(0, 8)}…`}</span>
				<time
					dateTime={run.startedAt}
					className="ml-auto text-xs text-muted-foreground tabular-nums"
				>
					{formatAbsolute(run.startedAt)}
				</time>
			</div>
		</Link>
	);
}

function LoadingState() {
	return (
		<div className="space-y-2">
			<span className="sr-only">Loading replays…</span>
			<div aria-hidden="true" className="space-y-2">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-14 w-full" />
				))}
			</div>
		</div>
	);
}

function EmptyState() {
	return (
		<Card>
			<CardHeader className="items-center text-center">
				<CardTitle>No replays yet.</CardTitle>
				<CardDescription>Use the Replay button to create one.</CardDescription>
			</CardHeader>
		</Card>
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
					Failed to load replays.
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
