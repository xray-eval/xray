import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { listConversations } from "../api/api.ts";
import type { ConversationSummary } from "../api/api.types.ts";

export function ConversationsList() {
	const query = useQuery({
		queryKey: ["conversations"],
		queryFn: ({ signal }) => listConversations(signal),
	});

	return (
		<section>
			<header className="mb-6 flex items-baseline justify-between">
				<h2 className="text-2xl font-semibold">Conversations</h2>
				<p className="text-sm text-muted-foreground">
					Each Conversation is a Python test definition. Replays land underneath as they run.
				</p>
			</header>
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
									<ConversationRow conversation={item} />
								</li>
							))}
						</ul>
					),
				)
				.exhaustive()}
		</section>
	);
}

function ConversationRow({ conversation }: { conversation: ConversationSummary }) {
	return (
		<Link
			to="/conversations/$conversationId"
			params={{ conversationId: conversation.id }}
			className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
		>
			<Card className="transition-colors hover:bg-muted/40">
				<CardHeader>
					<CardTitle className="flex items-center justify-between gap-3">
						<span className="truncate">{conversation.title ?? conversation.id}</span>
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
		</Link>
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
