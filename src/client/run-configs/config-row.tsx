import type { RunConfigSummary } from "@/client/api/api.types.ts";
import { shortHash } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import { accentAt } from "./column-accents.ts";
import { FacetChips } from "./facet-chips.tsx";
import type { RunConfigPair } from "./run-config-label.ts";

/**
 * One config in the picker, as a full-width row rather than a grid card.
 *
 * The grid spent two thirds of the page on repeated prefixes and pushed the
 * comparison — the thing the page is for — below the fold. A row gives the
 * distinguishing pairs the whole width, which is what they need to stay
 * readable, and forty of them fit in a scroll pane instead of a screenful.
 */
export function ConfigRow({
	item,
	pairs,
	accentIndex,
	disabled,
	onToggle,
}: {
	item: RunConfigSummary;
	pairs: readonly RunConfigPair[];
	/** Position in the comparison, or null when this config isn't in it. */
	accentIndex: number | null;
	disabled: boolean;
	onToggle: (hash: string) => void;
}) {
	const selected = accentIndex !== null;
	const named = item.name !== null && item.name.length > 0;
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={disabled}
			onClick={() => onToggle(item.hash)}
			className={cn(
				"group flex w-full items-center gap-3 rounded-md border py-2 pl-0 pr-3 text-left transition-colors",
				"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
				selected
					? "border-foreground/25 bg-muted/50"
					: "border-transparent hover:border-border/60 hover:bg-muted/20",
				disabled && "cursor-not-allowed opacity-40",
			)}
		>
			<span
				className={cn(
					"h-8 w-0.5 shrink-0 rounded-full transition-colors",
					accentIndex === null ? "bg-transparent group-hover:bg-border" : accentAt(accentIndex),
				)}
				aria-hidden
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				{named && <span className="truncate text-sm font-medium">{item.name}</span>}
				<FacetChips pairs={pairs} hash={item.hash} />
			</span>
			<Coverage item={item} />
		</button>
	);
}

function Coverage({ item }: { item: RunConfigSummary }) {
	const { conversations, replays, failed_replays } = item.coverage;
	if (replays === 0) {
		return (
			<span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/50">
				never run
			</span>
		);
	}
	return (
		<span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
			<span className="block">
				{conversations} conversation{conversations === 1 ? "" : "s"} · {replays} replay
				{replays === 1 ? "" : "s"}
			</span>
			{failed_replays > 0 && <span className="block text-warning">{failed_replays} failed</span>}
			<span className="block text-muted-foreground/50">{shortHash(item.hash)}</span>
		</span>
	);
}
