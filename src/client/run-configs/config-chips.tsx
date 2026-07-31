import { XIcon } from "lucide-react";

import type { RunConfigGroupResult } from "@/client/api/api.types.ts";
import { formatDurationMs } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import { accentAt } from "./column-accents.ts";
import type { ConfigFacets } from "./config-facets.ts";
import { facetLabelText } from "./config-facets.ts";
import { METRIC_ROWS } from "./metric-rows.ts";
import { runConfigLabel } from "./run-config-label.ts";

/**
 * One card per config under comparison, carrying its headline numbers.
 *
 * This is the layer the grids below don't provide: the grids answer "where
 * does this config struggle", and you need "how is it doing overall" first to
 * know which grid rows are worth reading. Position matches the grid columns,
 * so the accent colour is the same config in both places.
 */
export function ConfigChips({
	groups,
	facets,
	onRemove,
}: {
	groups: readonly RunConfigGroupResult[];
	facets: ConfigFacets;
	onRemove: (hash: string) => void;
}) {
	if (groups.length === 0) return null;
	return (
		<ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{groups.map((group, idx) => {
				// Distinguishing pairs only, for the same reason the grid headers use
				// them: the card truncates, and a label built from the full config
				// leads with what every config shares — so unnamed configs read as
				// identical cards whose remove buttons all announce the same name.
				const label = facetLabelText(
					group.name,
					facets.distinguishing.get(group.hash) ?? [],
					group.hash,
				);
				return (
					<li
						key={group.hash}
						aria-label={label}
						className="flex items-start gap-2 rounded-md border border-border/60 py-2 pl-0 pr-2"
					>
						<span className={cn("h-full w-0.5 shrink-0 self-stretch", accentAt(idx))} aria-hidden />
						<div className="min-w-0 flex-1 space-y-1.5">
							<div className="flex items-baseline justify-between gap-2">
								<span
									className="truncate text-xs font-medium"
									title={runConfigLabel(group.name, group.config, group.hash)}
								>
									{label}
								</span>
								<button
									type="button"
									aria-label={`Remove ${label} from comparison`}
									onClick={() => onRemove(group.hash)}
									className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
								>
									<XIcon className="size-3" aria-hidden />
								</button>
							</div>
							<HeadlineStats group={group} />
						</div>
					</li>
				);
			})}
		</ul>
	);
}

/** The four numbers worth reading before opening any grid. */
function HeadlineStats({ group }: { group: RunConfigGroupResult }) {
	const stat = (key: string) => METRIC_ROWS.find((row) => row.key === key)?.read(group.metrics);
	// The median, not the mean the aggregate table leads with: one pathological
	// turn moves an average enough to misrepresent the run at a glance, and a
	// glance is all this row is for.
	const p50 = group.metrics.agent_response_ms.p50;
	return (
		<dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
			<Stat label="judge" value={stat("judges")?.display ?? "—"} />
			<Stat label="assert" value={stat("assertions")?.display ?? "—"} />
			<Stat label="p50 v2v" value={p50 === null ? "—" : formatDurationMs(p50)} />
			<Stat label="replays" value={String(group.coverage.replays)} />
			{group.coverage.failed_replays > 0 && (
				<div className="flex items-baseline gap-1 text-warning">
					<dt className="sr-only">failed replays</dt>
					<dd>{group.coverage.failed_replays} failed</dd>
				</div>
			)}
		</dl>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline gap-1">
			<dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">{label}</dt>
			<dd className="text-foreground">{value}</dd>
		</div>
	);
}
