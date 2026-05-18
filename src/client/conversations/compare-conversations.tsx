import { useQueries } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { getConversation } from "../api/api.ts";
import type { ConversationResponse, ConversationTurn } from "../api/api.types.ts";

const COMPARE_COUNT = 2;

interface ConversationPair {
	readonly conversationId: string;
	readonly version: string;
}

export function CompareConversations() {
	const { ids } = useSearch({ from: "/compare/conversations" });
	const pairs = parseConversationPairs(ids);

	const queries = useQueries({
		queries: pairs.map((pair) => ({
			queryKey: ["conversations", { id: pair.conversationId, version: pair.version }] as const,
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				getConversation(pair.conversationId, { version: pair.version, signal }),
			enabled: pairs.length === COMPARE_COUNT,
		})),
	});

	if (pairs.length !== COMPARE_COUNT) {
		return (
			<section>
				<CompareHeader />
				<p role="alert" className="text-sm text-destructive">
					Compare requires exactly {COMPARE_COUNT} Conversation ids.
				</p>
			</section>
		);
	}

	const status = combineStatus(queries.map((q) => q.status));

	return (
		<section>
			<CompareHeader />
			{match(status)
				.with("pending", () => (
					<div role="status" aria-label="Loading conversations" aria-busy="true">
						<Skeleton className="h-96 w-full" />
					</div>
				))
				.with("error", () => (
					<p role="alert" className="text-destructive">
						Failed to load one or both conversations.
					</p>
				))
				.with("success", () => {
					const conversations = queries.map((q) => q.data).filter(isConversation);
					if (conversations.length !== COMPARE_COUNT) {
						return (
							<p role="alert" className="text-destructive">
								Failed to load one or both conversations.
							</p>
						);
					}
					return <ConversationsGrid conversations={conversations} />;
				})
				.exhaustive()}
		</section>
	);
}

function CompareHeader() {
	return (
		<header className="mb-4">
			<Link to="/" className="text-sm text-muted-foreground hover:underline">
				<span aria-hidden="true">←</span> Conversations
			</Link>
			<h2 className="mt-2 text-2xl font-semibold">Compare conversations</h2>
		</header>
	);
}

interface AlignedTurnRow {
	readonly key: string;
	readonly cells: readonly (ConversationTurn | undefined)[];
	readonly matched: boolean;
}

function ConversationsGrid({ conversations }: { conversations: readonly ConversationResponse[] }) {
	const rows = alignTurnsByKey(conversations);
	const matchedCount = rows.filter((r) => r.matched).length;
	const matchPct = rows.length === 0 ? 0 : Math.round((matchedCount / rows.length) * 100);

	return (
		<>
			<p
				role="status"
				aria-live="polite"
				className="mb-4 text-sm text-muted-foreground"
				data-testid="match-summary"
			>
				{matchedCount} of {rows.length} turns matched ({matchPct}%)
			</p>
			<div className="overflow-x-auto">
				<table
					className="w-full border-separate border-spacing-3"
					aria-label="Conversation comparison"
				>
					<thead>
						<tr>
							{conversations.map((c) => (
								<th
									key={`${c.id}-${c.version}`}
									scope="col"
									className="min-w-[280px] text-left align-top"
								>
									<Card>
										<CardHeader>
											<CardTitle className="text-base">
												<span className="truncate">{c.title ?? c.id}</span>
											</CardTitle>
										</CardHeader>
										<CardContent className="text-xs text-muted-foreground">
											<div className="font-mono">{c.id}</div>
											<div>version {c.version}</div>
											<div>{c.turns.length} turns</div>
										</CardContent>
									</Card>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.key}>
								{row.cells.map((turn, idx) => {
									const conversation = conversations[idx];
									if (conversation === undefined) return null;
									return (
										<td
											key={`${conversation.id}-${conversation.version}-${row.key}`}
											className="min-w-[280px] rounded border p-2 align-top text-xs"
										>
											<div className="mb-1 flex items-center justify-between text-muted-foreground">
												<span>key: {row.key}</span>
												{turn !== undefined && (
													<Badge variant="outline">{turn.role}</Badge>
												)}
											</div>
											{turn === undefined ? (
												<p className="text-muted-foreground italic">no matching turn</p>
											) : (
												<p className="whitespace-pre-wrap text-sm">{turn.text ?? "(no text)"}</p>
											)}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

export function parseConversationPairs(raw: string | undefined): ConversationPair[] {
	if (raw === undefined || raw.length === 0) return [];
	const pairs: ConversationPair[] = [];
	for (const segment of raw.split(",")) {
		if (segment.length === 0) continue;
		const colonIdx = segment.indexOf(":");
		if (colonIdx === -1) continue;
		const conversationId = segment.slice(0, colonIdx);
		const version = segment.slice(colonIdx + 1);
		if (conversationId.length === 0 || version.length === 0) continue;
		pairs.push({ conversationId, version });
	}
	return pairs;
}

export function alignTurnsByKey(
	conversations: readonly ConversationResponse[],
): readonly AlignedTurnRow[] {
	const keyOrder: string[] = [];
	const seen = new Set<string>();
	const byConversation: ReadonlyMap<string, ConversationTurn>[] = conversations.map((c) => {
		const map = new Map<string, ConversationTurn>();
		for (const turn of c.turns) {
			if (turn.key === undefined) continue;
			if (!seen.has(turn.key)) {
				seen.add(turn.key);
				keyOrder.push(turn.key);
			}
			if (!map.has(turn.key)) map.set(turn.key, turn);
		}
		return map;
	});

	return keyOrder.map((key) => {
		const cells = byConversation.map((m) => m.get(key));
		const matched = cells.every((c) => c !== undefined);
		return { key, cells, matched };
	});
}

type CombinedStatus = "pending" | "error" | "success";

function combineStatus(statuses: readonly ("pending" | "error" | "success")[]): CombinedStatus {
	if (statuses.some((s) => s === "error")) return "error";
	if (statuses.some((s) => s === "pending")) return "pending";
	return "success";
}

function isConversation(value: ConversationResponse | undefined): value is ConversationResponse {
	return value !== undefined;
}
