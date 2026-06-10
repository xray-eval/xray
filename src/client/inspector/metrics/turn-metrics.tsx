import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/client/components/ui/table.tsx";
import { formatClockSeconds, formatDurationMs } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import type { TurnMetricsResponse } from "../../api/api.types.ts";

const METRIC_HEAD = "h-7 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-normal";

/**
 * Per-turn timing for the Run details panel: the silence gap before the agent
 * responds (`agent_response_ms`), time-to-first-token, and barge-in. Sits with
 * model usage + tool calls — observability data, not a pass/fail verdict.
 */
export function TurnMetricsSection({ turns }: { turns: TurnMetricsResponse[] }) {
	if (turns.length === 0) return null;
	return (
		<section className="px-5 py-4">
			<div className="mb-3 flex items-baseline justify-between gap-3">
				<h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-foreground/70">
					Per-turn metrics
				</h3>
				<span className="font-mono text-[10px] tracking-wide tabular-nums text-muted-foreground/70">
					{turns.length} {turns.length === 1 ? "turn" : "turns"}
				</span>
			</div>
			<Table className="w-full table-fixed font-mono text-xs tabular-nums">
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className={cn(METRIC_HEAD, "w-10 pl-0")}>turn</TableHead>
						<TableHead className={METRIC_HEAD}>role</TableHead>
						<TableHead className={cn(METRIC_HEAD, "text-right")}>resp</TableHead>
						<TableHead className={cn(METRIC_HEAD, "text-right")}>ttft</TableHead>
						<TableHead className={cn(METRIC_HEAD, "pr-0 text-right")}>barge-in</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{turns.map((turn) => (
						<TurnMetricRow key={turn.turn_idx} turn={turn} />
					))}
				</TableBody>
			</Table>
		</section>
	);
}

function TurnMetricRow({ turn }: { turn: TurnMetricsResponse }) {
	return (
		<TableRow className="border-border/40 hover:bg-transparent">
			<TableCell className="pl-0 text-muted-foreground">
				T{String(turn.turn_idx).padStart(2, "0")}
			</TableCell>
			<TableCell className="text-foreground/80">{turn.role}</TableCell>
			<TableCell className="text-right text-foreground/80">
				{formatMetricMs(turn.agent_response_ms)}
			</TableCell>
			<TableCell className="text-right text-foreground/80">
				{formatMetricMs(turn.ttft_ms)}
			</TableCell>
			<TableCell className="pr-0 text-right">
				{turn.interrupted ? (
					<span className="text-warning">
						{turn.interruption_start_ms === null
							? "yes"
							: formatClockSeconds(turn.interruption_start_ms / 1000)}
					</span>
				) : (
					<span className="text-muted-foreground/40">—</span>
				)}
			</TableCell>
		</TableRow>
	);
}

function formatMetricMs(ms: number | null): string {
	return ms === null ? "—" : formatDurationMs(ms);
}
