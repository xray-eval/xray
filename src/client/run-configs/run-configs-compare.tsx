import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { compareRunConfigs, listRunConfigs } from "@/client/api/api.ts";
import type {
	CompareRunConfigsResponse,
	ConversationScope,
	ReplaySelection,
	RunConfigGroupResult,
	RunConfigSummary,
} from "@/client/api/api.types.ts";
import { Badge } from "@/client/components/ui/badge.tsx";
import { Button } from "@/client/components/ui/button.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import { shortHash } from "@/client/format.ts";
import { cn } from "@/client/lib/utils.ts";

import { MetricCell } from "./metric-cell.tsx";
import { bestCellIndex, METRIC_ROWS } from "./metric-rows.ts";
import { runConfigLabel } from "./run-config-label.ts";

const MIN_COMPARE = 2;
const MAX_COMPARE = 8;

export function RunConfigsCompare() {
	const search = useSearch({ from: "/configs" });
	const groups = useQuery({
		queryKey: ["run-configs"],
		queryFn: ({ signal }) => listRunConfigs(signal),
	});

	return (
		<section className="space-y-8">
			<header className="space-y-1">
				<h2 className="text-xl font-semibold tracking-tight">Run configs</h2>
				<p className="max-w-2xl text-sm text-muted-foreground">
					Every configuration your agent has run under, compared across all the conversations it
					ran. Pick two or more to see which strategy is actually faster.
				</p>
			</header>

			{match(groups)
				.with({ status: "pending" }, () => (
					<div role="status" aria-label="Loading run configs" aria-busy="true">
						<Skeleton className="h-64 w-full" />
					</div>
				))
				.with({ status: "error" }, () => (
					<p role="alert" className="text-sm text-destructive">
						Failed to load run configs.
					</p>
				))
				.with({ status: "success" }, (q) =>
					q.data.items.length === 0 ? (
						<EmptyState />
					) : (
						<CompareBody items={q.data.items} search={search} />
					),
				)
				.exhaustive()}
		</section>
	);
}

export interface ConfigsSearch {
	readonly ids?: string | undefined;
	readonly replays?: ReplaySelection | undefined;
	readonly scope?: ConversationScope | undefined;
}

function CompareBody({
	items,
	search,
}: {
	items: readonly RunConfigSummary[];
	search: ConfigsSearch;
}) {
	const navigate = useNavigate();
	const selection = resolveSelection(search.ids, items);
	const replaySelection = search.replays ?? "latest";
	const scope = search.scope ?? "union";

	function setSearch(next: Partial<ConfigsSearch>) {
		void navigate({
			to: "/configs",
			search: { ids: selection.join(","), replays: replaySelection, scope, ...next },
		});
	}

	const comparison = useQuery({
		queryKey: ["run-configs", "compare", { ids: selection, replaySelection, scope }],
		queryFn: ({ signal }) =>
			compareRunConfigs(
				{
					config_hashes: selection,
					replay_selection: replaySelection,
					conversation_scope: scope,
				},
				signal,
			),
		enabled: selection.length >= MIN_COMPARE,
	});

	return (
		<>
			<ConfigPicker
				items={items}
				selected={selection}
				onToggle={(hash) => setSearch({ ids: toggle(selection, hash).join(",") })}
			/>

			<div className="flex flex-wrap items-center gap-6 border-y border-border/60 py-3">
				<ModeToggle
					label="Replays"
					value={replaySelection}
					options={[
						{ value: "latest", label: "Latest per conversation" },
						{ value: "all", label: "All completed" },
					]}
					onChange={(value) => setSearch({ replays: value })}
				/>
				<ModeToggle
					label="Conversations"
					value={scope}
					options={[
						{ value: "union", label: "All ran" },
						{ value: "intersection", label: "Only shared" },
					]}
					onChange={(value) => setSearch({ scope: value })}
				/>
			</div>

			{selection.length < MIN_COMPARE ? (
				<p className="text-sm text-muted-foreground">
					Select at least {MIN_COMPARE} configs to compare.
				</p>
			) : (
				match(comparison)
					.with({ status: "pending" }, () => (
						<div role="status" aria-label="Loading comparison" aria-busy="true">
							<Skeleton className="h-96 w-full" />
						</div>
					))
					.with({ status: "error" }, () => (
						<p role="alert" className="text-sm text-destructive">
							Failed to load the comparison.
						</p>
					))
					.with({ status: "success" }, (q) => (
						<>
							<CoverageNotice
								comparison={q.data}
								scope={scope}
								onUseIntersection={() => setSearch({ scope: "intersection" })}
							/>
							<MetricsMatrix comparison={q.data} />
						</>
					))
					.exhaustive()
			)}
		</>
	);
}

/**
 * The fair-comparison guardrail. When the selected configs didn't all run the
 * same conversations, an average over "all ran" is an average over different
 * workloads — so say it in words and offer the one-click fix, rather than
 * leaving the user to notice a coverage number they weren't looking at.
 */
function CoverageNotice({
	comparison,
	scope,
	onUseIntersection,
}: {
	comparison: CompareRunConfigsResponse;
	scope: ConversationScope;
	onUseIntersection: () => void;
}) {
	const uneven = comparison.groups.some(
		(group) => group.coverage.conversations < comparison.union_conversations,
	);
	if (!uneven) return null;

	if (scope === "intersection") {
		return (
			<p
				role="status"
				className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
			>
				Comparing the {comparison.intersection_conversations} conversation
				{comparison.intersection_conversations === 1 ? "" : "s"} every selected config ran. Runs
				outside that shared set are excluded from these numbers.
			</p>
		);
	}
	return (
		<div
			role="status"
			className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
		>
			<p>
				These configs didn't all run the same conversations, so the averages cover different
				workloads. Only {comparison.intersection_conversations} of {comparison.union_conversations}{" "}
				conversations were run by every config.
			</p>
			<Button variant="outline" size="sm" onClick={onUseIntersection}>
				Compare shared only
			</Button>
		</div>
	);
}

function ConfigPicker({
	items,
	selected,
	onToggle,
}: {
	items: readonly RunConfigSummary[];
	selected: readonly string[];
	onToggle: (hash: string) => void;
}) {
	return (
		<ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
			{items.map((item) => {
				const isSelected = selected.includes(item.hash);
				const atCap = !isSelected && selected.length >= MAX_COMPARE;
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
	);
}

function ModeToggle<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<fieldset className="flex items-center gap-2 border-0 p-0">
			{/* The legend names the group for assistive tech; the visible span is the
			    styled copy of the same word, so it's hidden from the a11y tree. */}
			<legend className="sr-only">{label}</legend>
			<span
				aria-hidden
				className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
			>
				{label}
			</span>
			<div className="flex rounded-md border border-border/60 p-0.5">
				{options.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={option.value === value}
						onClick={() => onChange(option.value)}
						className={cn(
							"rounded px-2.5 py-1 text-xs transition-colors",
							"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
							option.value === value
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				))}
			</div>
		</fieldset>
	);
}

function MetricsMatrix({ comparison }: { comparison: CompareRunConfigsResponse }) {
	const groups = comparison.groups;
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-3xl border-collapse" aria-label="Run config comparison">
				<thead>
					<tr>
						<th scope="col" className="w-44 pb-3 text-left align-bottom">
							<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
								Metric
							</span>
						</th>
						{groups.map((group, idx) => (
							<ConfigColumnHeader
								key={group.hash}
								group={group}
								unionConversations={comparison.union_conversations}
								accentIndex={idx}
							/>
						))}
					</tr>
				</thead>
				<tbody>
					{METRIC_ROWS.map((row) => {
						const cells = groups.map((group) => row.read(group.metrics));
						const best = bestCellIndex(
							cells.map((cell) => cell.value),
							row.better,
						);
						return (
							<tr key={row.key} className="border-t border-border/60">
								<th scope="row" className="py-3 pr-4 text-left align-top">
									<span className="block text-sm font-medium">{row.label}</span>
									<span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
										{row.unit}
									</span>
								</th>
								{cells.map((cell, idx) => (
									<td key={groups[idx]?.hash ?? idx} className="py-2 pr-2 align-top">
										<MetricCell cell={cell} best={best === idx} />
									</td>
								))}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

// Chart tokens are used only as a per-column identity stripe, never on the
// numbers themselves — the data stays achromatic so `best` is the only visual
// ranking signal in the table.
const COLUMN_ACCENTS = [
	"bg-chart-1",
	"bg-chart-2",
	"bg-chart-3",
	"bg-chart-4",
	"bg-chart-5",
] as const;

function ConfigColumnHeader({
	group,
	unionConversations,
	accentIndex,
}: {
	group: RunConfigGroupResult;
	unionConversations: number;
	accentIndex: number;
}) {
	const partial = group.coverage.conversations < unionConversations;
	return (
		<th scope="col" className="min-w-56 pb-3 text-left align-bottom">
			<div
				className={cn("mb-2 h-0.5 w-8", COLUMN_ACCENTS[accentIndex % COLUMN_ACCENTS.length])}
				aria-hidden
			/>
			<Link
				to="/configs/$configHash"
				params={{ configHash: group.hash }}
				className="block rounded-sm text-sm font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				{runConfigLabel(group.name, group.config, group.hash)}
			</Link>
			<div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
				{shortHash(group.hash)}…
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
				<span
					className={cn(
						"font-mono text-[11px] tabular-nums",
						partial ? "text-warning" : "text-muted-foreground",
					)}
				>
					ran {group.coverage.conversations}/{unionConversations}
				</span>
				{group.coverage.failed_replays > 0 && (
					<Badge variant="outline" className="font-mono text-[10px] font-normal">
						{group.coverage.failed_replays} failed
					</Badge>
				)}
			</div>
		</th>
	);
}

function EmptyState() {
	return (
		<div className="rounded-lg border border-dashed border-border/60 px-6 py-16 text-center">
			<p className="mx-auto max-w-md text-sm text-muted-foreground">
				No run configs yet. Pass{" "}
				<code className="font-mono text-xs">run_config=RunConfig(name="baseline", model=…)</code> to{" "}
				<code className="font-mono text-xs">xray.run(...)</code> and every replay under that config
				gets grouped here.
			</p>
		</div>
	);
}

/**
 * Selection comes from the URL so a comparison is shareable. With no `ids`, the
 * two most recently active configs are compared — the view is useful on first
 * open instead of showing an empty prompt. Derived at render, never mirrored
 * into state.
 */
export function resolveSelection(
	raw: string | undefined,
	items: readonly RunConfigSummary[],
): string[] {
	const known = new Set(items.map((item) => item.hash));
	const requested = (raw ?? "")
		.split(",")
		.map((hash) => hash.trim())
		.filter((hash) => known.has(hash));
	const deduped = [...new Set(requested)].slice(0, MAX_COMPARE);
	if (deduped.length > 0) return deduped;
	return items.slice(0, MIN_COMPARE).map((item) => item.hash);
}

function toggle(selected: readonly string[], hash: string): string[] {
	if (selected.includes(hash)) return selected.filter((h) => h !== hash);
	if (selected.length >= MAX_COMPARE) return [...selected];
	return [...selected, hash];
}
