import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Button } from "@/client/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

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
			prev.some((p) => p.id === item.id)
				? prev.filter((p) => p.id !== item.id)
				: [...prev, item],
		);
	}

	const canCompare = selected.length === COMPARE_COUNT;

	return (
		<section>
			<header className="mb-6 flex items-baseline justify-between">
				<h2 className="text-2xl font-semibold">Conversations</h2>
				<p className="text-sm text-muted-foreground">
					Each Conversation is a Python test definition. Replays land underneath as they run.
				</p>
			</header>
			<div className="mb-3 flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					{selected.length === 0
						? "Tick two rows to compare their turn definitions."
						: `${selected.length} selected`}
				</p>
				<div className="flex flex-col items-end gap-1">
					<Button
						variant={canCompare ? "default" : "secondary"}
						disabled={!canCompare}
						aria-describedby="compare-conversations-hint"
						onClick={() =>
							navigate({
								to: "/compare/conversations",
								search: { ids: selected.map((s) => `${s.id}:${s.latestVersion}`).join(",") },
							})
						}
					>
						Compare ({selected.length})
					</Button>
					<p id="compare-conversations-hint" className="text-xs text-muted-foreground">
						Pick exactly two Conversations to compare.
					</p>
				</div>
			</div>
			{match(query)
				.with({ status: "pending" }, () => <ConversationsListSkeleton />)
				.with({ status: "error" }, () => (
					<p role="alert" className="text-destructive">
						Failed to load conversations.
					</p>
				))
				.with({ status: "success" }, (q) =>
					q.data.items.length === 0 ? (
						<EmptyState />
					) : (
						<ul className="grid gap-3">
							{q.data.items.map((item) => (
								<li key={item.id}>
									<ConversationRow
										conversation={item}
										selected={selected.some((s) => s.id === item.id)}
										onToggle={() => toggle(item)}
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

function ConversationRow({
	conversation,
	selected,
	onToggle,
}: {
	conversation: ConversationSummary;
	selected: boolean;
	onToggle: () => void;
}) {
	return (
		<Card className={selected ? "border-primary transition-colors" : "transition-colors hover:bg-muted/40"}>
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<input
							type="checkbox"
							checked={selected}
							onChange={onToggle}
							aria-label={`Select conversation ${conversation.id} to compare`}
						/>
						<Link
							to="/conversations/$conversationId"
							params={{ conversationId: conversation.id }}
							className="truncate rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							{conversation.title ?? conversation.id}
						</Link>
					</div>
					<span className="flex items-center gap-2">
						<Badge variant="outline">{conversation.versions} versions</Badge>
						<Badge variant="secondary">{conversation.replays} replays</Badge>
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="text-xs text-muted-foreground">
				<span className="font-mono">{conversation.id}</span>
				<span className="mx-2">·</span>
				<span>latest {conversation.latestVersion}</span>
			</CardContent>
		</Card>
	);
}

const SKELETON_SLOTS = ["a", "b", "c"] as const;
function ConversationsListSkeleton() {
	return (
		<ul className="grid gap-3">
			{SKELETON_SLOTS.map((slot) => (
				<li key={slot}>
					<Skeleton className="h-20 w-full" />
				</li>
			))}
		</ul>
	);
}

function EmptyState() {
	return (
		<Card className="border-dashed">
			<CardContent className="py-12 text-center text-sm text-muted-foreground">
				No conversations yet. Author one in Python with
				<code className="mx-1 rounded bg-muted px-1.5 py-0.5">xray-py</code> and run it against your
				LiveKit room — see <code className="ml-1">docs/SDK.md</code>.
			</CardContent>
		</Card>
	);
}
