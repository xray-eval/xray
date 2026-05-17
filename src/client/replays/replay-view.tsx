import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { AlertCircle, Loader2 } from "lucide-react";
import { match } from "ts-pattern";

import type { ReplayRunResponse } from "@/server/replays/replays.types.ts";

import { fetchReplay } from "../api/replays-api.ts";
import { Badge } from "../components/ui/badge.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card.tsx";
import { Separator } from "../components/ui/separator.tsx";
import { BackToSessionsLink } from "../router/back-to-sessions-link.tsx";
import { DiffPanel } from "./replay-diff.tsx";

const route = getRouteApi("/replays/$replayId");

const ACTIVE_POLL_INTERVAL_MS = 750;
/** TanStack-Query sentinel meaning "stop polling" — distinct from a number interval. */
const STOP_POLLING = false as const;

type ReplayQueryKey = readonly ["replay", { id: string }];

export function ReplayView() {
	const { replayId } = route.useParams();
	const replayQuery = useQuery<ReplayRunResponse, Error, ReplayRunResponse, ReplayQueryKey>({
		queryKey: ["replay", { id: replayId }] as const,
		queryFn: ({ signal }) => fetchReplay({ id: replayId, signal }),
		refetchInterval: (q) => {
			const status = q.state.data?.status;
			return status === "pending" || status === "running" ? ACTIVE_POLL_INTERVAL_MS : STOP_POLLING;
		},
	});

	return (
		<section aria-label="Replay" aria-busy={replayQuery.isPending} className="space-y-6">
			<header className="flex items-baseline justify-between gap-4">
				<BackToSessionsLink />
			</header>

			{match(replayQuery)
				.with({ status: "pending" }, () => <LoadingState />)
				.with({ status: "error" }, (q) => <ErrorState error={q.error} />)
				.with({ status: "success" }, (q) => <ReplayBody run={q.data} />)
				.exhaustive()}
		</section>
	);
}

function ReplayBody({ run }: { run: ReplayRunResponse }) {
	return (
		<div className="space-y-6">
			<ReplayHeader run={run} />
			<Separator />
			{match(run.status)
				.with("pending", "running", () => <RunningPanel run={run} />)
				.with("failed", () => <FailedPanel run={run} />)
				.with("completed", () => <DiffPanel run={run} />)
				.exhaustive()}
		</div>
	);
}

function ReplayHeader({ run }: { run: ReplayRunResponse }) {
	return (
		<div className="space-y-2">
			<h2 className="text-2xl font-semibold tracking-tight">Replay</h2>
			<dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-sm">
				<div className="flex items-baseline gap-2">
					<dt className="text-muted-foreground">Source</dt>
					<dd className="font-mono">{run.sourceSessionId}</dd>
				</div>
				<div className="flex items-baseline gap-2">
					<dt className="text-muted-foreground">Target</dt>
					<dd className="font-mono">{run.targetSessionId}</dd>
				</div>
				<div className="flex items-baseline gap-2">
					<dt className="sr-only">Status</dt>
					<dd>
						<StatusBadge status={run.status} />
					</dd>
				</div>
			</dl>
		</div>
	);
}

function StatusBadge({ status }: { status: ReplayRunResponse["status"] }) {
	return match(status)
		.with("pending", () => <Badge variant="outline">pending</Badge>)
		.with("running", () => <Badge variant="secondary">running</Badge>)
		.with("completed", () => <Badge variant="default">completed</Badge>)
		.with("failed", () => <Badge variant="destructive">failed</Badge>)
		.exhaustive();
}

function RunningPanel({ run }: { run: ReplayRunResponse }) {
	const { completed, total } = run.progress;
	const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Loader2 className="size-4 animate-spin" />
					Replaying turns
				</CardTitle>
				<CardDescription>
					{completed} of {total} user turns processed
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
					<div
						className="h-full bg-primary transition-[width] duration-300"
						style={{ width: `${pct}%` }}
						role="progressbar"
						aria-label="Replay progress"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={pct}
					/>
				</div>
			</CardContent>
		</Card>
	);
}

function FailedPanel({ run }: { run: ReplayRunResponse }) {
	return (
		<Card role="alert">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<AlertCircle className="size-4 text-destructive" />
					Replay failed
				</CardTitle>
				<CardDescription className="break-all">{run.error ?? "Unknown error"}</CardDescription>
			</CardHeader>
		</Card>
	);
}

function LoadingState() {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Loader2 className="size-4 animate-spin" />
					Loading replay…
				</CardTitle>
			</CardHeader>
		</Card>
	);
}

function ErrorState({ error }: { error: Error }) {
	return (
		<Card role="alert">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<AlertCircle className="size-4 text-destructive" />
					Failed to load replay.
				</CardTitle>
				<CardDescription className="break-all">{error.message}</CardDescription>
			</CardHeader>
		</Card>
	);
}
