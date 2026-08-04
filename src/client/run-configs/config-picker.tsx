import { ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";

import type { RunConfigSummary } from "@/client/api/api.types.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/client/components/ui/popover.tsx";

import type { ConfigFacets } from "./config-facets.ts";
import { partitionByActivity } from "./config-filter.ts";
import { ConfigList } from "./config-list.tsx";

/**
 * Picks which config groups the matrix compares.
 *
 * A dropdown rather than an inline list: at forty-odd configs an inline list
 * costs several hundred pixels of every visit, and it is above the comparison
 * — so the page pushes its own answer off the screen to show a chooser that is
 * mostly not being used. Collapsed, this is one row. What's currently selected
 * stays visible in the rail, which is the part worth permanent space.
 */
export function ConfigPicker({
	items,
	facets,
	selected,
	onToggle,
}: {
	items: readonly RunConfigSummary[];
	facets: ConfigFacets;
	selected: readonly string[];
	onToggle: (hash: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const { active } = partitionByActivity(items);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			{/* No `aria-label`: it would replace the trigger's contents for the
			    accessible name, and the ran/total count below is the part worth
			    knowing before opening the list. The prompt text names the button on
			    its own, so the label bought nothing and cost the counts. */}
			<PopoverTrigger className="flex w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-transparent px-3 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
				<span className="text-muted-foreground">Choose configs to compare</span>
				<span className="flex items-center gap-2">
					<span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
						{active.length} ran · {items.length} total
					</span>
					<ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
				</span>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				// Match the trigger so rows get the full page width to lay their
				// distinguishing pairs out in.
				className="w-[var(--radix-popover-trigger-width)] p-2"
			>
				<ConfigList items={items} facets={facets} selected={selected} onToggle={onToggle} />
			</PopoverContent>
		</Popover>
	);
}
