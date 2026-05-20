import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { match } from "ts-pattern";

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

import { listConversations } from "../api/api.ts";
import type { ConversationSummary } from "../api/api.types.ts";

const COMPARE_COUNT = 2;

export function ConversationsList() {
	const navigate = useNavigate();
	const [selected, setSelected] = useState<readonly ConversationSummary[]>([]);
	const query = useQuery({
		queryKey: ["conversations"],
		queryFn: ({ signal }) => listConversations(signal),
	});

	function toggle(item: ConversationSummary) {
		setSelected((prev) =>
			prev.some((p) => p.id === item.id) ? prev.filter((p) => p.id !== item.id) : [...prev, item],
		);
	}

	const canCompare = selected.length === COMPARE_COUNT;

	return (
		<section className="space-y-8">
			<div className="flex flex-col gap-1">
				<h2 className="text-xl font-semibold tracking-tight">Conversations</h2>
				<p className="text-sm text-muted-foreground">
					Each Conversation is a test definition authored with the xray SDK. Tick two rows to diff
					their turn structure.
				</p>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3 text-xs text-muted-foreground">
				<span>{selected.length === 0 ? "No selection" : `${selected.length} selected`}</span>
				<div className="flex items-center gap-3">
					<span id="compare-conversations-hint" className="hidden sm:inline">
						Pick exactly two to compare.
					</span>
					<Button
						variant={canCompare ? "default" : "outline"}
						size="sm"
						disabled={!canCompare}
						aria-describedby="compare-conversations-hint"
						onClick={() =>
							navigate({
								to: "/compare/conversations",
								search: { ids: selected.map((s) => `${s.id}:${s.latest_version}`).join(",") },
							})
						}
					>
						Compare ({selected.length})
					</Button>
				</div>
			</div>

			{match(query)
				.with({ status: "pending" }, () => <ConversationsTableSkeleton />)
				.with({ status: "error" }, () => (
					<p role="alert" className="text-sm text-destructive">
						Failed to load conversations.
					</p>
				))
				.with({ status: "success" }, (q) =>
					q.data.items.length === 0 ? (
						<EmptyState />
					) : (
						<ConversationsTable items={q.data.items} selected={selected} onToggle={toggle} />
					),
				)
				.exhaustive()}
		</section>
	);
}

function ConversationsTable({
	items,
	selected,
	onToggle,
}: {
	items: readonly ConversationSummary[];
	selected: readonly ConversationSummary[];
	onToggle: (item: ConversationSummary) => void;
}) {
	const navigate = useNavigate();
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			<Table className="text-sm">
				<TableHeader className="bg-muted/30">
					<TableRow className="border-border/60 hover:bg-transparent">
						<TableHead className="w-10 px-4" />
						<TableHead className="px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Title
						</TableHead>
						<TableHead className="px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
							ID
						</TableHead>
						<TableHead className="px-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Versions
						</TableHead>
						<TableHead className="px-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Replays
						</TableHead>
						<TableHead className="px-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
							Latest
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.map((item) => (
						<ConversationRow
							key={item.id}
							conversation={item}
							selected={selected.some((s) => s.id === item.id)}
							onToggle={() => onToggle(item)}
							onOpen={() =>
								navigate({
									to: "/conversations/$conversationId",
									params: { conversationId: item.id },
								})
							}
						/>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function ConversationRow({
	conversation,
	selected,
	onToggle,
	onOpen,
}: {
	conversation: ConversationSummary;
	selected: boolean;
	onToggle: () => void;
	onOpen: () => void;
}) {
	return (
		<ClickableRow
			selected={selected}
			onToggle={onToggle}
			onOpen={onOpen}
			selectLabel={`Select conversation ${conversation.id} to compare`}
		>
			<TableCell className="px-4 py-3 font-medium">
				<Link
					to="/conversations/$conversationId"
					params={{ conversationId: conversation.id }}
					onClick={stopRowNavigation}
					className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{conversation.title ?? conversation.id}
				</Link>
			</TableCell>
			<TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
				{conversation.id}
			</TableCell>
			<TableCell className="px-4 py-3 text-right tabular-nums">{conversation.versions}</TableCell>
			<TableCell className="px-4 py-3 text-right tabular-nums">{conversation.replays}</TableCell>
			<TableCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
				{conversation.latest_version}
			</TableCell>
		</ClickableRow>
	);
}

const SKELETON_SLOTS = ["a", "b", "c", "d"] as const;
function ConversationsTableSkeleton() {
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			<div className="divide-y divide-border/60">
				{SKELETON_SLOTS.map((slot) => (
					<div key={slot} className="flex items-center gap-4 px-4 py-3">
						<Skeleton className="size-4 rounded" />
						<Skeleton className="h-4 flex-1" />
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-4 w-12" />
					</div>
				))}
			</div>
		</div>
	);
}

function EmptyState() {
	return (
		<div className="rounded-lg border border-dashed border-border/60 px-6 py-16 text-center">
			<p className="text-sm text-muted-foreground">
				No conversations yet. Author one with the xray SDK and run it against your LiveKit room —
				see <code className="font-mono text-xs">docs/SDK.md</code>.
			</p>
		</div>
	);
}
