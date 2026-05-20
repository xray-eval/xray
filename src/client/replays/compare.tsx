import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { compareReplays } from "../api/api.ts";
import type { ReplayDetailResponse, ReplayTurnResponse } from "../api/api.types.ts";
import { formatTimestamp } from "../format.ts";
import type { RunConfigDiffCell } from "./run-config-diff.ts";
import { diffRunConfigs } from "./run-config-diff.ts";

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
			<section>
				<CompareHeader />
				<p role="alert" className="text-sm text-destructive">
					Compare requires between {MIN_COMPARE} and {MAX_COMPARE} replay ids.
				</p>
			</section>
		);
	}

	return (
		<section>
			<CompareHeader />
			{match(query)
				.with({ status: "pending" }, () => (
					<div role="status" aria-label="Loading comparison" aria-busy="true">
						<Skeleton className="h-96 w-full" />
					</div>
				))
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

function CompareHeader() {
	return (
		<header className="mb-4">
			<Link to="/" className="text-sm text-muted-foreground hover:underline">
				<span aria-hidden="true">←</span> Conversations
			</Link>
			<h2 className="mt-2 text-2xl font-semibold">Compare replays</h2>
		</header>
	);
}

function ReplaysGrid({ replays }: { replays: ReplayDetailResponse[] }) {
	const allKeys = collectKeys(replays);
	const runConfigRows = diffRunConfigs(replays.map((r) => r.run_config));
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-separate border-spacing-3" aria-label="Replay comparison">
				<thead>
					<tr>
						{replays.map((r) => (
							<th key={r.id} scope="col" className="min-w-[240px] text-left align-top">
								<Card>
									<CardHeader>
										<CardTitle className="text-base">
											<span className="font-mono">{r.id.slice(0, 8)}…</span>
										</CardTitle>
									</CardHeader>
									<CardContent className="text-xs text-muted-foreground">
										<div>v{r.conversation_version}</div>
										<div>{formatTimestamp(r.started_at)}</div>
									</CardContent>
								</Card>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{runConfigRows.length > 0 && (
						<tr>
							<td
								colSpan={replays.length}
								className="pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								Run config
							</td>
						</tr>
					)}
					{runConfigRows.map((row) => (
						<tr key={`run-config-${row.key}`} aria-label={`run_config.${row.key}`}>
							{row.cells.map((cell, idx) => {
								const replay = replays[idx];
								if (replay === undefined) return null;
								return (
									<td
										key={`${replay.id}-run-config-${row.key}`}
										className={runConfigCellClass(cell)}
									>
										<div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
											{row.key}
										</div>
										{cell.present ? (
											<pre className="whitespace-pre-wrap break-all text-[11px]">
												{JSON.stringify(cell.value)}
											</pre>
										) : (
											<p className="text-muted-foreground italic">absent</p>
										)}
									</td>
								);
							})}
						</tr>
					))}
					{allKeys.length > 0 && (
						<tr>
							<td
								colSpan={replays.length}
								className="pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								Turns
							</td>
						</tr>
					)}
					{allKeys.map((key) => (
						<KeyRow key={key} keyName={key} replays={replays} />
					))}
				</tbody>
			</table>
		</div>
	);
}

function runConfigCellClass(cell: RunConfigDiffCell): string {
	const base = "min-w-[240px] rounded border p-2 align-top text-xs";
	if (cell.differsFromBaseline) return `${base} bg-yellow-50 dark:bg-yellow-950/30`;
	return base;
}

function KeyRow({ keyName, replays }: { keyName: string; replays: ReplayDetailResponse[] }) {
	return (
		<tr>
			{replays.map((r) => {
				// `key` is not unique within a replay, only `(replay_id, idx)` is.
				// Surface every matching turn so a duplicate-keyed run isn't silently
				// reduced to its first turn.
				const matchingTurns = r.turns.filter((t) => t.key === keyName);
				return (
					<td
						key={`${r.id}-${keyName}`}
						className="min-w-[240px] rounded border p-2 align-top text-xs"
					>
						<div className="mb-1 flex items-center justify-between text-muted-foreground">
							<span>key: {keyName}</span>
							{matchingTurns.length > 0 && (
								<Badge variant="outline">{matchingTurns[0]?.role}</Badge>
							)}
						</div>
						{matchingTurns.length === 0 ? (
							<p className="text-muted-foreground italic">no matching turn</p>
						) : (
							<ul className="grid gap-1">
								{matchingTurns.map((turn) => (
									<li key={`${r.id}-${keyName}-${turn.idx}`}>
										<TurnSnippet turn={turn} />
									</li>
								))}
							</ul>
						)}
					</td>
				);
			})}
		</tr>
	);
}

function TurnSnippet({ turn }: { turn: ReplayTurnResponse }) {
	return (
		<p className="line-clamp-6 whitespace-pre-wrap text-sm">
			{turn.transcript ?? "(no transcript)"}
		</p>
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
