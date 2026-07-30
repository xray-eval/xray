import type { RunConfigSummary } from "@/client/api/api.types.ts";
import { cn } from "@/client/lib/utils.ts";

import { MAX_COMPARE } from "./compare-selection.ts";
import { runConfigLabel } from "./run-config-label.ts";

/** The card grid that picks which config groups the matrix compares. */
export function ConfigPicker({
	items,
	selected,
	onToggle,
}: {
	items: readonly RunConfigSummary[];
	selected: readonly string[];
	onToggle: (hash: string) => void;
}) {
	const atCapacity = selected.length >= MAX_COMPARE;
	return (
		<div className="space-y-2">
			<ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((item) => {
					const isSelected = selected.includes(item.hash);
					const atCap = !isSelected && atCapacity;
					return (
						<li key={item.hash}>
							<button
								type="button"
								aria-pressed={isSelected}
								disabled={atCap}
								onClick={() => onToggle(item.hash)}
								className={cn(
									"w-full rounded-lg border px-4 py-3 text-left transition-colors",
									"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
									isSelected
										? "border-foreground/30 bg-muted/50"
										: "border-border/60 hover:border-border hover:bg-muted/20",
									atCap && "cursor-not-allowed opacity-50",
								)}
							>
								<span className="block truncate text-sm font-medium">
									{runConfigLabel(item.name, item.config, item.hash)}
								</span>
								<span className="mt-1 block font-mono text-[11px] tabular-nums text-muted-foreground">
									{item.coverage.conversations} conversation
									{item.coverage.conversations === 1 ? "" : "s"} · {item.coverage.replays} replay
									{item.coverage.replays === 1 ? "" : "s"}
									{item.coverage.failed_replays > 0 && ` · ${item.coverage.failed_replays} failed`}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{/* Without this, hitting the cap just greys out every remaining card,
			    which reads as a broken page rather than a limit. */}
			{atCapacity && (
				<p role="status" className="text-[11px] text-muted-foreground">
					Comparing the maximum of {MAX_COMPARE} configs. Deselect one to swap another in.
				</p>
			)}
		</div>
	);
}
