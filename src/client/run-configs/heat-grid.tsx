import type { CompareRunConfigsResponse } from "@/client/api/api.types.ts";
import { cn } from "@/client/lib/utils.ts";

import { accentAt } from "./column-accents.ts";
import type { RankedMetricRow } from "./heat-scale.ts";
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
}: {
	comparison: CompareRunConfigsResponse;
	row: RankedMetricRow;
}) {
	const { conversations, groups } = comparison;
	if (conversations.length === 0) return null;

	const cellFor = (groupIdx: number, conversationHash: string) =>
		groups[groupIdx]?.conversations.find((c) => c.conversation_hash === conversationHash);

	// Scaled per grid, not per column: the comparison is between configs on the
	// same conversation, so they have to share one scale.
	const range = heatRange(
		conversations.flatMap((conv) =>
			groups.map((_, idx) => {
				const cell = cellFor(idx, conv.hash);
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
								{/* Trailing room so adjacent truncated headers read as two
								    labels rather than one run-on string. */}
								<span
									className="block truncate pr-2 text-[11px] font-medium"
									title={runConfigLabel(group.name, group.config, group.hash)}
								>
									{runConfigLabel(group.name, group.config, group.hash)}
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
							{groups.map((_, idx) => (
								<HeatCell
									key={groups[idx]?.hash ?? idx}
									cell={cellFor(idx, conv.hash)}
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
	row,
	range,
}: {
	cell: { metrics: Parameters<RankedMetricRow["read"]>[0] } | undefined;
	row: RankedMetricRow;
	range: ReturnType<typeof heatRange>;
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
	const intensity = range === null ? null : heatIntensity(measured.value, range, row.better);
	return (
		<td className="py-0.5 pl-1">
			<div
				className="rounded-sm px-2 py-1 text-center font-mono text-[11px] tabular-nums"
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
			</div>
		</td>
	);
}
