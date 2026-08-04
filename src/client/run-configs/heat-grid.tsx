import { Link } from "@tanstack/react-router";

import type { CompareRunConfigsResponse, RunConfigCompareCell } from "@/client/api/api.types.ts";
import { cn } from "@/client/lib/utils.ts";

import { accentAt } from "./column-accents.ts";
import type { ConfigFacets } from "./config-facets.ts";
import { facetLabelText } from "./config-facets.ts";
import type { HeatRange, RankedMetricRow } from "./heat-scale.ts";
import { heatIntensity, heatRange } from "./heat-scale.ts";
import { runConfigLabel } from "./run-config-label.ts";

/**
 * One metric across every conversation and config at once: conversations down,
 * configs across, shading by how good each number is for its own grid.
 *
 * The aggregate table answers "which config is faster overall" and hides the
 * shape of it — one catastrophic conversation and one great one average into
 * something unremarkable. Here that shows up as a dark cell in a light row,
 * which is the thing worth chasing.
 */
export function HeatGrid({
	comparison,
	row,
	facets,
}: {
	comparison: CompareRunConfigsResponse;
	row: RankedMetricRow;
	facets: ConfigFacets;
}) {
	const { conversations, groups } = comparison;
	if (conversations.length === 0) return null;

	// Indexed once per grid rather than scanned per cell: every cell is visited
	// twice (once to size the scale, once to render), and there is one grid per
	// ranked metric, so a linear `find` turns the page into groups × rows ×
	// metrics × cells.
	const cellsByGroup = groups.map(
		(group) => new Map(group.conversations.map((cell) => [cell.conversation_hash, cell])),
	);

	// Scaled per grid, not per column: the comparison is between configs on the
	// same conversation, so they have to share one scale.
	const range = heatRange(
		conversations.flatMap((conv) =>
			cellsByGroup.map((cells) => {
				const cell = cells.get(conv.hash);
				return cell === undefined ? null : row.read(cell.metrics).value;
			}),
		),
	);

	// Nothing in this grid was measured. Rendering it would spend a screenful
	// of em-dashes saying what its absence says.
	if (range === null) return null;

	return (
		<div className="overflow-x-auto">
			{/* Sized to content, not the page: stretched cells put whole
			    centimetres between the numbers being compared, which is the eye
			    travel the grid exists to remove. */}
			<table
				className="table-fixed border-collapse text-left"
				// Fixed layout so the declared column widths are authoritative:
				// under auto layout the browser widens a column to fit its header,
				// which reintroduces the eye travel the narrow cells remove.
				style={{ width: `calc(11rem + ${groups.length} * 6rem)` }}
				aria-label={`${row.label} per conversation and config`}
			>
				<thead>
					<tr>
						<th scope="col" className="sticky left-0 z-10 w-44 bg-background pb-2">
							<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
								{row.label}
							</span>
						</th>
						{groups.map((group, idx) => (
							<th key={group.hash} scope="col" className="w-24 pb-2 pl-1 align-bottom">
								<div className={cn("mb-1 h-0.5 w-6", accentAt(idx))} aria-hidden />
								{/* Only what distinguishes this config from the others being
								    compared. A column is 6rem wide and truncates, and the full
								    summary leads with the pairs every config shares — so
								    truncation ate the one pair that identified the column and
								    every header rendered the same string. The whole config
								    stays one hover away. Trailing room so adjacent truncated
								    labels read as two rather than one run-on string. */}
								<span
									className="block truncate pr-2 text-[11px] font-medium"
									title={runConfigLabel(group.name, group.config, group.hash)}
								>
									{facetLabelText(
										group.name,
										facets.distinguishing.get(group.hash) ?? [],
										group.hash,
									)}
								</span>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{conversations.map((conv) => (
						<tr key={conv.hash}>
							<th
								scope="row"
								className="sticky left-0 z-10 max-w-40 truncate bg-background py-0.5 pr-2 text-[11px] font-normal text-muted-foreground"
							>
								{conv.name}
							</th>
							{cellsByGroup.map((cells, idx) => (
								<HeatCell
									key={groups[idx]?.hash ?? idx}
									cell={cells.get(conv.hash)}
									conversationName={conv.name}
									row={row}
									range={range}
								/>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function HeatCell({
	cell,
	conversationName,
	row,
	range,
}: {
	cell: RunConfigCompareCell | undefined;
	conversationName: string;
	row: RankedMetricRow;
	range: HeatRange;
}) {
	if (cell === undefined) {
		return (
			<td aria-label="not run" className="py-0.5 pl-1">
				<div className="rounded-sm border border-dashed border-border/40 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-muted-foreground/40">
					—
				</div>
			</td>
		);
	}
	const measured = row.read(cell.metrics);
	const intensity = heatIntensity(measured.value, range, row.better);
	return (
		<td className="py-0.5 pl-1">
			{/* Spotting a bad cell is only half the loop — the other half is going and
			    listening to the run that produced it, and the cell's own replay is the
			    only thing that identifies which one that was. */}
			<Link
				to="/replays/$replayId"
				params={{ replayId: cell.replay_id }}
				// The bare number is a useless link name outside the table's row and
				// column context, and a reader listing every link would get "50%"
				// once per cell with nothing telling them apart.
				aria-label={`${conversationName}: ${measured.display} — open this replay`}
				className="block rounded-sm px-2 py-1 text-center font-mono text-[11px] tabular-nums transition-shadow hover:ring-1 hover:ring-border focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
				// Mirrors the inline background as an assertable value: happy-dom
				// drops `color-mix(...)` on assignment, so the style attribute never
				// reaches the DOM under test and a broken scale would look exactly
				// like a working one.
				data-intensity={intensity ?? undefined}
				// Inline because the value is continuous — a Tailwind class per
				// bucket would quantise the very gradient the grid exists to show.
				style={
					intensity === null
						? undefined
						: {
								backgroundColor: `color-mix(in oklch, var(--chart-2) ${intensity * 55}%, transparent)`,
							}
				}
			>
				{measured.display}
			</Link>
		</td>
	);
}
