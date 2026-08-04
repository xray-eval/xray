import { Link } from "@tanstack/react-router";

import type {
	CompareRunConfigsResponse,
	ConversationScope,
	ReplaySelection,
	RunConfigGroupResult,
} from "@/client/api/api.types.ts";
import { Badge } from "@/client/components/ui/badge.tsx";
import { shortHash } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import { accentAt } from "./column-accents.ts";
import { MetricCell } from "./metric-cell.tsx";
import { bestCellIndex, METRIC_ROWS } from "./metric-rows.ts";
import { runConfigLabel } from "./run-config-label.ts";

/**
 * The metric-name column stays pinned while the config columns scroll. Past
 * about four configs the table is wider than the page, and scrolling a plain
 * table takes the row labels with it — leaving columns of numbers with nothing
 * saying which metric each row is. `bg-background` is load-bearing: without it
 * the scrolling cells show through the pinned column.
 */
const METRIC_COL = "sticky left-0 z-10 w-44 min-w-44 bg-background text-left";

export function MetricsMatrix({ comparison }: { comparison: CompareRunConfigsResponse }) {
	const groups = comparison.groups;
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-3xl border-collapse" aria-label="Run config comparison">
				<thead>
					<tr>
						<th scope="col" className={cn(METRIC_COL, "pb-3 align-bottom")}>
							<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
								Metric
							</span>
						</th>
						{groups.map((group, idx) => (
							<ConfigColumnHeader
								key={group.hash}
								group={group}
								unionConversations={comparison.union_conversations}
								scope={comparison.conversation_scope}
								replaySelection={comparison.replay_selection}
								accentIndex={idx}
							/>
						))}
					</tr>
				</thead>
				<tbody>
					{METRIC_ROWS.map((row) => {
						const cells = groups.map((group) => row.read(group.metrics));
						const best = bestCellIndex(
							cells.map((cell) => cell.value),
							row.better,
						);
						return (
							<tr key={row.key} className="border-t border-border/60">
								<th scope="row" className={cn(METRIC_COL, "py-3 pr-4 align-top")}>
									<span className="block text-sm font-medium">{row.label}</span>
									<span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
										{row.unit}
									</span>
								</th>
								{cells.map((cell, idx) => (
									<td key={groups[idx]?.hash ?? idx} className="py-2 pr-2 align-top">
										<MetricCell cell={cell} best={best === idx} />
									</td>
								))}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function ConfigColumnHeader({
	group,
	unionConversations,
	scope,
	replaySelection,
	accentIndex,
}: {
	group: RunConfigGroupResult;
	unionConversations: number;
	scope: ConversationScope;
	replaySelection: ReplaySelection;
	accentIndex: number;
}) {
	// `coverage` describes what the numbers in this column were computed over,
	// which under `intersection` is the shared subset — not what the config ran.
	// Saying "ran 1/3" about a config that ran all 3 would be a plain untruth in
	// a view whose whole pitch is honest numbers, so the verb changes with the
	// scope instead.
	const partial = group.coverage.conversations < unionConversations;
	const coverageLabel =
		scope === "intersection"
			? `compared on ${group.coverage.conversations} of ${unionConversations}`
			: `ran ${group.coverage.conversations}/${unionConversations}`;
	return (
		<th scope="col" className="min-w-56 pb-3 text-left align-bottom">
			<div className={cn("mb-2 h-0.5 w-8", accentAt(accentIndex))} aria-hidden />
			{/* Carry the replay selection through: clicking a column to hear the run
			    behind a number, and landing on a page that recomputed it under a
			    different selection, silently changes the number being explained. */}
			<Link
				to="/configs/$configHash"
				params={{ configHash: group.hash }}
				search={{ replays: replaySelection }}
				className="block rounded-sm text-sm font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				{runConfigLabel(group.name, group.config, group.hash)}
			</Link>
			<div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
				{shortHash(group.hash)}…
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
				<span
					className={cn(
						"font-mono text-[11px] tabular-nums",
						// Only the union view flags partial coverage: under intersection
						// every column is deliberately narrowed to the same subset, so
						// warning-colouring all of them would signal a problem where the
						// user just made a choice.
						partial && scope === "union" ? "text-warning" : "text-muted-foreground",
					)}
				>
					{coverageLabel}
				</span>
				{group.coverage.failed_replays > 0 && (
					<Badge variant="outline" className="font-mono text-[10px] font-normal">
						{group.coverage.failed_replays} failed
					</Badge>
				)}
			</div>
		</th>
	);
}
