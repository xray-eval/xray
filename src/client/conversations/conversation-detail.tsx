import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Button } from "@/client/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { getConversation, listReplaysForConversation } from "../api/api.ts";
import type { ReplaySummaryResponse } from "../api/api.types.ts";
import { formatTimestamp } from "../format.ts";

const MIN_COMPARE = 2;
const MAX_COMPARE = 8;

export function ConversationDetail() {
	const { conversationId } = useParams({ from: "/conversations/$conversationId" });
	const navigate = useNavigate();
	const [selected, setSelected] = useState<readonly string[]>([]);

	const conversation = useQuery({
		queryKey: ["conversations", { id: conversationId }],
		queryFn: ({ signal }) => getConversation(conversationId, { signal }),
	});

	const replays = useQuery({
		queryKey: ["conversations", { id: conversationId }, "replays"],
		queryFn: ({ signal }) => listReplaysForConversation(conversationId, signal),
	});

	function toggle(replayId: string) {
		setSelected((prev) =>
			prev.includes(replayId) ? prev.filter((id) => id !== replayId) : [...prev, replayId],
		);
	}

	const canCompare = selected.length >= MIN_COMPARE && selected.length <= MAX_COMPARE;

	return (
		<section>
			<header className="mb-6">
				<Link to="/" className="text-sm text-muted-foreground hover:underline">
					<span aria-hidden="true">←</span> Conversations
				</Link>
				<h2 className="mt-2 text-2xl font-semibold">
					{match(conversation)
						.with({ status: "pending" }, () => <Skeleton className="inline-block h-7 w-48" />)
						.with({ status: "error" }, () => conversationId)
						.with({ status: "success" }, (q) => q.data.title ?? q.data.id)
						.exhaustive()}
				</h2>
				<p className="text-xs text-muted-foreground font-mono">{conversationId}</p>
			</header>

			<div className="mb-3 flex items-center justify-between gap-3">
				<h3 className="text-lg font-medium">Replays</h3>
				<div className="flex flex-col items-end gap-1">
					<Button
						variant={canCompare ? "default" : "secondary"}
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
					<p id="compare-hint" className="text-xs text-muted-foreground">
						Select {MIN_COMPARE}–{MAX_COMPARE} replays to compare.
					</p>
				</div>
			</div>

			{match(replays)
				.with({ status: "pending" }, () => <ReplaysListSkeleton />)
				.with({ status: "error" }, () => (
					<p role="alert" className="text-destructive">
						Failed to load replays.
					</p>
				))
				.with({ status: "success" }, (q) =>
					q.data.items.length === 0 ? (
						<ReplaysEmptyState />
					) : (
						<ul className="grid gap-2">
							{q.data.items.map((r) => (
								<li key={r.id}>
									<ReplayRow
										replay={r}
										selected={selected.includes(r.id)}
										onToggle={() => toggle(r.id)}
									/>
								</li>
							))}
						</ul>
					),
				)
				.exhaustive()}
		</section>
	);
}

function ReplayRow({
	replay,
	selected,
	onToggle,
}: {
	replay: ReplaySummaryResponse;
	selected: boolean;
	onToggle: () => void;
}) {
	return (
		<Card className={selected ? "border-primary" : undefined}>
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-3 text-base">
					<div className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={selected}
							onChange={onToggle}
							aria-label={`Select replay ${replay.id} for compare`}
						/>
						<Link
							to="/replays/$replayId"
							params={{ replayId: replay.id }}
							className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							<span className="font-mono text-sm">{replay.id.slice(0, 8)}…</span>
						</Link>
					</div>
					<StatusChip replay={replay} />
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
				<span>v{replay.conversationVersion}</span>
				<span>started {formatTimestamp(replay.startedAt)}</span>
				{replay.judgeStatus !== null && (
					<span>
						judge: <Badge variant="outline">{replay.judgeStatus}</Badge>
						{replay.judgeScore !== null ? ` (${replay.judgeScore})` : ""}
					</span>
				)}
				{replay.runConfig !== null && typeof replay.runConfig === "object" && (
					<span className="truncate max-w-[40ch] font-mono">
						run_config: {JSON.stringify(replay.runConfig)}
					</span>
				)}
			</CardContent>
		</Card>
	);
}

function StatusChip({ replay }: { replay: ReplaySummaryResponse }) {
	return match(replay.status)
		.with("running", () => <Badge variant="secondary">running</Badge>)
		.with("completed", () => <Badge>completed</Badge>)
		.with("failed", () => {
			const reason = replay.failureReason;
			return (
				<Badge
					variant="destructive"
					title={reason ?? ""}
					aria-label={reason !== null ? `failed: ${reason}` : "failed"}
				>
					failed{reason !== null ? `: ${reason}` : ""}
				</Badge>
			);
		})
		.exhaustive();
}

const SKELETON_SLOTS = ["a", "b", "c"] as const;
function ReplaysListSkeleton() {
	return (
		<ul className="grid gap-2">
			{SKELETON_SLOTS.map((slot) => (
				<li key={slot}>
					<Skeleton className="h-16 w-full" />
				</li>
			))}
		</ul>
	);
}

function ReplaysEmptyState() {
	return (
		<Card className="border-dashed">
			<CardContent className="py-10 text-center text-sm text-muted-foreground">
				No replays for this Conversation yet. Run it with the SDK to record one.
			</CardContent>
		</Card>
	);
}
