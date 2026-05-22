import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { match, P } from "ts-pattern";

import { BackLink } from "@/client/components/back-link.tsx";
import { Breadcrumbs } from "@/client/components/breadcrumbs.tsx";
import { ClickableRow, stopRowNavigation } from "@/client/components/clickable-row.tsx";
import { Button } from "@/client/components/ui/button.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/client/components/ui/table.tsx";
import { shortHash } from "@/client/format.ts";

import { getConversation, listReplaysForConversation } from "../api/api.ts";
import type { ReplaySummaryResponse } from "../api/api.types.ts";
import { formatTimestamp } from "../format.ts";
import { RunStatusBadge } from "../replay-status/replay-status.tsx";

const MIN_COMPARE = 2;
const MAX_COMPARE = 8;

export function ConversationDetail() {
	const { conversationHash } = useParams({ from: "/conversations/$conversationHash" });
	const navigate = useNavigate();
	const [selected, setSelected] = useState<readonly string[]>([]);

	const conversation = useQuery({
		queryKey: ["conversations", { hash: conversationHash }],
		queryFn: ({ signal }) => getConversation(conversationHash, signal),
	});

	const replays = useQuery({
		queryKey: ["conversations", { hash: conversationHash }, "replays"],
		queryFn: ({ signal }) => listReplaysForConversation(conversationHash, signal),
	});

	function toggle(replayId: string) {
		setSelected((prev) =>
			prev.includes(replayId) ? prev.filter((id) => id !== replayId) : [...prev, replayId],
		);
	}

	const canCompare = selected.length >= MIN_COMPARE && selected.length <= MAX_COMPARE;

	const conversationLabel = match(conversation)
		.with({ status: "success" }, (q) => q.data.name)
		.with(P.union({ status: "pending" }, { status: "error" }), () => shortHash(conversationHash))
		.exhaustive();

	return (
		<section className="space-y-10">
			<div className="space-y-5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<BackLink to="/">Conversations</BackLink>
					<Breadcrumbs
						crumbs={[
							{ label: "Conversations", to: "/" },
							{ label: conversationLabel, current: true },
						]}
					/>
				</div>
				<div className="space-y-1.5">
					<h2 className="text-2xl font-semibold tracking-tight">
						{match(conversation)
							.with({ status: "pending" }, () => <Skeleton className="inline-block h-7 w-48" />)
							.with({ status: "error" }, () => shortHash(conversationHash))
							.with({ status: "success" }, (q) => q.data.name)
							.exhaustive()}
					</h2>
					<p className="font-mono text-xs text-muted-foreground">{shortHash(conversationHash)}…</p>
				</div>
			</div>

			<div className="space-y-4">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div className="space-y-1">
						<h3 className="text-base font-semibold tracking-tight">Replays</h3>
						<p className="text-xs text-muted-foreground">
							Each run of this Conversation against your LiveKit agent.
						</p>
					</div>
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						<span id="compare-hint" className="hidden sm:inline">
							Select {MIN_COMPARE}–{MAX_COMPARE} replays to compare.
						</span>
						<Button
							variant={canCompare ? "default" : "outline"}
							size="sm"
							disabled={!canCompare}
							aria-describedby="compare-hint"
							onClick={() =>
								navigate({
									to: "/compare/replays",
									search: { ids: selected.join(",") },
								})
							}
						>
							Compare ({selected.length})
						</Button>
					</div>
				</div>

				{match(replays)
					.with({ status: "pending" }, () => <ReplaysTableSkeleton />)
					.with({ status: "error" }, () => (
						<p role="alert" className="text-sm text-destructive">
							Failed to load replays.
						</p>
					))
					.with({ status: "success" }, (q) =>
						q.data.items.length === 0 ? (
							<ReplaysEmptyState />
						) : (
							<ReplaysTable replays={q.data.items} selected={selected} onToggle={toggle} />
						),
					)
					.exhaustive()}
			</div>
		</section>
	);
}

function ReplaysTable({
	replays,
	selected,
	onToggle,
}: {
	replays: readonly ReplaySummaryResponse[];
	selected: readonly string[];
	onToggle: (id: string) => void;
}) {
	const navigate = useNavigate();
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			<Table className="text-sm">
				<TableHeader className="bg-muted/30">
					<TableRow className="border-border/60 hover:bg-transparent">
						<TableHead className="w-10 px-4" />
						<TableHead className="px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
							ID
						</TableHead>
						<TableHead className="px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Status
						</TableHead>
						<TableHead className="px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Started
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{replays.map((r) => (
						<ReplayRow
							key={r.id}
							replay={r}
							selected={selected.includes(r.id)}
							onToggle={() => onToggle(r.id)}
							onOpen={() => navigate({ to: "/replays/$replayId", params: { replayId: r.id } })}
						/>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function ReplayRow({
	replay,
	selected,
	onToggle,
	onOpen,
}: {
	replay: ReplaySummaryResponse;
	selected: boolean;
	onToggle: () => void;
	onOpen: () => void;
}) {
	return (
		<ClickableRow
			selected={selected}
			onToggle={onToggle}
			onOpen={onOpen}
			selectLabel={`Select replay ${replay.id} for compare`}
		>
			<TableCell className="px-4 py-3 font-mono text-xs">
				<Link
					to="/replays/$replayId"
					params={{ replayId: replay.id }}
					onClick={stopRowNavigation}
					className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{replay.id.slice(0, 8)}…
				</Link>
			</TableCell>
			<TableCell className="px-4 py-3">
				<RunStatusBadge replay={replay} />
			</TableCell>
			<TableCell className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
				{formatTimestamp(replay.started_at)}
			</TableCell>
		</ClickableRow>
	);
}

const SKELETON_SLOTS = ["a", "b", "c"] as const;
function ReplaysTableSkeleton() {
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			<div className="divide-y divide-border/60">
				{SKELETON_SLOTS.map((slot) => (
					<div key={slot} className="flex items-center gap-4 px-4 py-3">
						<Skeleton className="size-4 rounded" />
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-4 flex-1" />
					</div>
				))}
			</div>
		</div>
	);
}

function ReplaysEmptyState() {
	return (
		<div className="rounded-lg border border-dashed border-border/60 px-6 py-16 text-center">
			<p className="text-sm text-muted-foreground">
				No replays for this Conversation yet. Run it with the SDK to record one.
			</p>
		</div>
	);
}
