import { shortHash } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import type { RunConfigPair } from "./run-config-label.ts";

/**
 * One chip per `key=value`, rather than one string of all of them.
 *
 * A single joined string truncates at its own tail, which is exactly where the
 * last — and often only distinguishing — pair sits. Chips truncate
 * independently, so every pair keeps a share of the width and the value stays
 * legible however many pairs there are.
 */
export function FacetChips({
	pairs,
	hash,
	className,
}: {
	pairs: readonly RunConfigPair[];
	hash: string;
	className?: string;
}) {
	if (pairs.length === 0) {
		return (
			<span className={cn("font-mono text-[11px] text-muted-foreground", className)}>
				{shortHash(hash)}
			</span>
		);
	}
	return (
		<span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
			{pairs.map((pair) => (
				<span
					key={pair.key}
					className="flex min-w-0 max-w-[22rem] items-baseline gap-px rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] leading-tight"
				>
					<span className="shrink-0 text-muted-foreground/70">{pair.key}</span>
					<span className="shrink-0 text-muted-foreground/40">=</span>
					<span className="truncate text-foreground">{pair.value}</span>
				</span>
			))}
		</span>
	);
}
