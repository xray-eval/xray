import { ChevronDownIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import type { RunConfigSummary } from "@/client/api/api.types.ts";
import { Input } from "@/client/components/ui/input.tsx";
import { cn } from "@/client/lib/utils.ts";

import { MAX_COMPARE } from "./compare-selection.ts";
import type { ConfigFacets } from "./config-facets.ts";
import { filterConfigs, partitionByActivity } from "./config-filter.ts";
import { ConfigRow } from "./config-row.tsx";
import { FacetChips } from "./facet-chips.tsx";

/**
 * The searchable body of the config chooser. Split from the popover that holds
 * it so the selection behaviour can be tested without driving a dropdown open.
 *
 * Facets arrive from the parent rather than being computed here, so this list
 * and the selection rail agree on what distinguishes a config — and so they
 * stay stable while the user types, instead of re-deriving from the filtered
 * subset and morphing mid-keystroke.
 */
export function ConfigList({
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
	const [query, setQuery] = useState("");
	const [showNeverRun, setShowNeverRun] = useState(false);

	const atCapacity = selected.length >= MAX_COMPARE;
	const matches = filterConfigs(items, query);
	const { active, neverRun } = partitionByActivity(matches);

	function rowFor(item: RunConfigSummary) {
		const position = selected.indexOf(item.hash);
		return (
			<li key={item.hash}>
				<ConfigRow
					item={item}
					pairs={facets.distinguishing.get(item.hash) ?? []}
					accentIndex={position === -1 ? null : position}
					disabled={position === -1 && atCapacity}
					onToggle={onToggle}
				/>
			</li>
		);
	}

	return (
		<div className="space-y-2">
			<Input
				type="search"
				aria-label="Filter configs"
				placeholder="Filter by name, key, value, or hash…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				className="h-8 font-mono text-xs"
			/>

			{facets.shared.length > 0 && (
				<div data-testid="shared-facets" className="flex flex-wrap items-center gap-2 px-1 pb-1">
					<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
						shared by all {items.length}
					</span>
					<FacetChips pairs={facets.shared} hash="" />
				</div>
			)}

			{matches.length === 0 ? (
				<p className="px-1 py-6 text-center text-sm text-muted-foreground">
					No configs match “{query}”.
				</p>
			) : (
				<>
					{active.length > 0 && (
						<div className="scroll-panel max-h-72 overflow-y-auto">
							<ul className="space-y-0.5 pr-1">{active.map(rowFor)}</ul>
						</div>
					)}

					{/* Outside the scroll pane on purpose — inside it, the disclosure
					    sits past the end of a long list and is never found. */}
					{neverRun.length > 0 && (
						<NeverRunSection
							count={neverRun.length}
							expanded={showNeverRun}
							// A config the query matched is a config the user asked for by
							// name; leaving it collapsed reads as "no such config". With
							// nothing active there is likewise nothing to collapse it out of
							// the way of.
							forcedOpen={active.length === 0 || query.trim().length > 0}
							onToggle={() => setShowNeverRun((open) => !open)}
						>
							{neverRun.map(rowFor)}
						</NeverRunSection>
					)}
				</>
			)}

			{/* Without this, hitting the cap just greys out every remaining row,
			    which reads as a broken page rather than a limit. */}
			{atCapacity && (
				<p
					role="status"
					className="border-t border-border/50 pt-2 text-[11px] text-muted-foreground"
				>
					Comparing the maximum of {MAX_COMPARE} configs. Deselect one to swap another in.
				</p>
			)}
		</div>
	);
}

/**
 * Groups no replay has run under, folded away by default — they can only ever
 * contribute an empty column. `forcedOpen` covers the cases where collapsing
 * them would hide the only thing the user is looking at, and drops the toggle
 * entirely rather than offering one that can't close.
 */
function NeverRunSection({
	count,
	expanded,
	forcedOpen,
	onToggle,
	children,
}: {
	count: number;
	expanded: boolean;
	forcedOpen: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	const label = `Never run (${count})`;
	return (
		<div className="border-t border-border/50 pt-2">
			{forcedOpen ? (
				<p className="px-1 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
					{label}
				</p>
			) : (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					className="flex items-center gap-1.5 rounded px-1 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{label}
					<ChevronDownIcon
						aria-hidden="true"
						className={cn("size-3 transition-transform", expanded && "rotate-180")}
					/>
				</button>
			)}
			{(expanded || forcedOpen) && (
				<div className="scroll-panel mt-1 max-h-64 overflow-y-auto">
					<ul className="space-y-0.5 pr-1">{children}</ul>
				</div>
			)}
		</div>
	);
}
