import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { BackLink } from "@/client/components/back-link.tsx";
import { Breadcrumbs } from "@/client/components/breadcrumbs.tsx";
import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import { shortHash } from "@/client/format.ts";

import { compareReplays } from "../api/api.ts";
import type { ReplayDetailResponse } from "../api/api.types.ts";
import { formatTimestamp } from "../format.ts";
import { RunStatusBadge } from "../replay-status/replay-status.tsx";
import type { RunConfigDiffCell } from "./run-config-diff.ts";
import { diffRunConfigs } from "./run-config-diff.ts";
import type { TurnDiffCell } from "./turn-diff.ts";
import { diffTurns } from "./turn-diff.ts";

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
		<header className="mb-8 space-y-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<BackLink to="/">Conversations</BackLink>
				<Breadcrumbs
					crumbs={[
						{ label: "Conversations", to: "/" },
						{ label: "Compare replays", current: true },
					]}
				/>
			</div>
			<h2 className="text-2xl font-semibold tracking-tight">Compare replays</h2>
		</header>
	);
}

function ReplaysGrid({ replays }: { replays: ReplayDetailResponse[] }) {
	const runConfigRows = diffRunConfigs(replays.map((r) => r.run_config));
	const turnRows = diffTurns(replays.map((r) => r.turns));
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-separate border-spacing-3" aria-label="Replay comparison">
				<thead>
					<tr>
						{replays.map((r) => (
							<th key={r.id} scope="col" className="min-w-[240px] text-left align-top">
								<Card>
									<CardHeader>
										<CardTitle className="flex items-center justify-between gap-2 text-base">
											<span className="font-mono">{r.id.slice(0, 8)}…</span>
											<RunStatusBadge replay={r} />
										</CardTitle>
									</CardHeader>
									<CardContent className="text-xs text-muted-foreground">
										<div className="font-mono">{shortHash(r.conversation_hash)}…</div>
										<div>{formatTimestamp(r.started_at)}</div>
										<div className="mt-1 tabular-nums">
											{r.turns.length} turn{r.turns.length === 1 ? "" : "s"} ·{" "}
											{r.speech_segments.length} segment
											{r.speech_segments.length === 1 ? "" : "s"}
										</div>
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
					{turnRows.length > 0 && (
						<tr>
							<td
								colSpan={replays.length}
								className="pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								Turns
							</td>
						</tr>
					)}
					{turnRows.map((row) => (
						<tr key={`turn-${row.idx}`} aria-label={`turn.${row.idx}`}>
							{row.cells.map((cell, idx) => {
								const replay = replays[idx];
								if (replay === undefined) return null;
								return (
									<td key={`${replay.id}-turn-${row.idx}`} className={turnCellClass(cell)}>
										<div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
											<span>turn #{row.idx}</span>
											{cell.turn !== undefined && (
												<Badge
													variant={cell.turn.role === "user" ? "secondary" : "default"}
													className="font-normal"
												>
													{cell.turn.role}
												</Badge>
											)}
										</div>
										{cell.turn !== undefined ? (
											<div className="tabular-nums text-[11px]">
												{formatMsRange(cell.turn.voice_start_ms, cell.turn.voice_end_ms)}
											</div>
										) : (
											<p className="text-muted-foreground italic">absent</p>
										)}
									</td>
								);
							})}
						</tr>
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

function turnCellClass(cell: TurnDiffCell): string {
	const base = "min-w-[240px] rounded border p-2 align-top text-xs";
	if (cell.differsFromBaseline) return `${base} bg-yellow-50 dark:bg-yellow-950/30`;
	return base;
}

function formatMsRange(startMs: number, endMs: number): string {
	const fmt = (ms: number) => (ms / 1000).toFixed(2);
	return `${fmt(startMs)}s → ${fmt(endMs)}s`;
}

function parseReplayIds(raw: string | undefined): string[] {
	if (raw === undefined || raw.length === 0) return [];
	return raw.split(",").filter((s) => s.length > 0);
}
