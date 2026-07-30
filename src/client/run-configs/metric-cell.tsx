import { cn } from "@/client/lib/utils.ts";

import type { MetricCell as MetricCellData } from "./metric-rows.ts";

/**
 * One measurement, in three typographic tiers: the number, the distribution
 * behind it, and the sample size it rests on. The tiers exist so a glance
 * reads the number and a second look tells you whether to trust it.
 */
export function MetricCell({ cell, best }: { cell: MetricCellData; best?: boolean }) {
	const unmeasured = cell.value === null;
	return (
		<div
			className={cn(
				"rounded-md border border-transparent px-3 py-2",
				best === true && "border-foreground/25 bg-muted/40",
			)}
			data-best={best === true ? "true" : undefined}
		>
			<div className="flex items-baseline gap-1.5">
				<span
					className={cn(
						"font-mono text-lg tabular-nums leading-none",
						unmeasured && "text-muted-foreground",
					)}
				>
					{cell.display}
				</span>
				{best === true && (
					<span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
						best
					</span>
				)}
			</div>
			{cell.detail !== null && (
				<div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
					{cell.detail}
				</div>
			)}
			<SampleSize n={cell.n} />
		</div>
	);
}

/**
 * Always rendered, including at zero. "n=0" is the honest reading of a metric
 * nothing emitted — an absent sample size would let an em-dash look like a
 * measurement of nothing rather than an absence of measurement.
 */
function SampleSize({ n }: { n: number }) {
	return (
		<div
			className={cn(
				"mt-1 font-mono text-[10px] tabular-nums",
				n === 0 ? "text-muted-foreground/70" : "text-muted-foreground",
			)}
		>
			n={n}
		</div>
	);
}
