import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { compareReplays } from "../api/api.ts";
import type { ReplayDetailResponse, ReplayTurnResponse } from "../api/api.types.ts";
import { formatTimestamp } from "../format.ts";

const MIN_COMPARE = 2;
const MAX_COMPARE = 8;

export function CompareReplays() {
	const { ids } = useSearch({ from: "/compare/replays" });
	const replayIds = parseReplayIds(ids);

	const query = useQuery({
		queryKey: ["replays", "compare", replayIds],
		queryFn: ({ signal }) => compareReplays(replayIds, signal),
		enabled: replayIds.length >= MIN_COMPARE && replayIds.length <= MAX_COMPARE,
	});

	if (replayIds.length < MIN_COMPARE || replayIds.length > MAX_COMPARE) {
		return (
			<p className="text-sm text-destructive">
				Compare requires between {MIN_COMPARE} and {MAX_COMPARE} replay ids.
			</p>
		);
	}

	return (
		<section>
			<h2 className="mb-4 text-2xl font-semibold">Compare replays</h2>
			{match(query)
				.with({ status: "pending" }, () => <Skeleton className="h-96 w-full" />)
				.with({ status: "error" }, () => (
					<p role="alert" className="text-destructive">
						Failed to load comparison.
					</p>
				))
				.with({ status: "success" }, (q) => <ReplaysGrid replays={q.data.replays} />)
				.exhaustive()}
		</section>
	);
}

function ReplaysGrid({ replays }: { replays: ReplayDetailResponse[] }) {
	const allKeys = collectKeys(replays);
	return (
		<div
			className="grid gap-3"
			style={{ gridTemplateColumns: `repeat(${replays.length}, minmax(0, 1fr))` }}
		>
			{replays.map((r) => (
				<Card key={r.id}>
					<CardHeader>
						<CardTitle className="text-base">
							<span className="font-mono">{r.id.slice(0, 8)}…</span>
						</CardTitle>
					</CardHeader>
					<CardContent className="text-xs text-muted-foreground">
						<div>v{r.conversationVersion}</div>
						<div>{formatTimestamp(r.startedAt)}</div>
						{r.runConfig !== null && r.runConfig !== undefined && (
							<pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2 text-[10px]">
								{JSON.stringify(r.runConfig, null, 2)}
							</pre>
						)}
					</CardContent>
				</Card>
			))}
			{allKeys.map((key) => (
				<KeyRow key={key} keyName={key} replays={replays} />
			))}
		</div>
	);
}

function KeyRow({ keyName, replays }: { keyName: string; replays: ReplayDetailResponse[] }) {
	return (
		<>
			{replays.map((r) => {
				const turn = r.turns.find((t) => t.key === keyName) ?? null;
				return (
					<div key={`${r.id}-${keyName}`} className="rounded border p-2 text-xs">
						<div className="mb-1 flex items-center justify-between text-muted-foreground">
							<span>key: {keyName}</span>
							{turn !== null && <Badge variant="outline">{turn.role}</Badge>}
						</div>
						{turn === null ? (
							<p className="text-muted-foreground italic">no matching turn</p>
						) : (
							<TurnSnippet turn={turn} />
						)}
					</div>
				);
			})}
		</>
	);
}

function TurnSnippet({ turn }: { turn: ReplayTurnResponse }) {
	return (
		<div>
			<p className="line-clamp-6 whitespace-pre-wrap text-sm">
				{turn.transcript ?? "(no transcript)"}
			</p>
		</div>
	);
}

function parseReplayIds(raw: string | undefined): string[] {
	if (raw === undefined || raw.length === 0) return [];
	return raw.split(",").filter((s) => s.length > 0);
}

function collectKeys(replays: ReplayDetailResponse[]): string[] {
	const set = new Set<string>();
	for (const r of replays) {
		for (const t of r.turns) {
			if (t.key !== null) set.add(t.key);
		}
	}
	return [...set];
}
