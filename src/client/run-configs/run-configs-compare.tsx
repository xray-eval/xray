import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { compareRunConfigs, listRunConfigs } from "@/client/api/api.ts";
import type { RunConfigSummary } from "@/client/api/api.types.ts";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import type { ConfigsSearch } from "@/client/router/router.ts";

import { MIN_COMPARE, resolveSelection, toggleSelection } from "./compare-selection.ts";
import { ConfigChips } from "./config-chips.tsx";
import { splitConfigFacets } from "./config-facets.ts";
import { ConfigPicker } from "./config-picker.tsx";
import { CoverageNotice } from "./coverage-notice.tsx";
import { HeatGrid } from "./heat-grid.tsx";
import { rankedMetricRows } from "./heat-scale.ts";
import { MetricsMatrix } from "./metrics-matrix.tsx";
import { ModeToggle } from "./mode-toggle.tsx";
import { runConfigLabel } from "./run-config-label.ts";

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
				.with({ status: "success" }, (q) => {
					// Below two configs there is nothing to compare and no second card
					// to click, so the picker would be a prompt the user can't act on.
					const [only] = q.data.items;
					if (only === undefined) return <EmptyState />;
					if (q.data.items.length < MIN_COMPARE) return <OneConfigState item={only} />;
					return <CompareBody items={q.data.items} search={search} />;
				})
				.exhaustive()}
		</section>
	);
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

	const facets = splitConfigFacets(items);
	function toggle(hash: string) {
		setSearch({ ids: toggleSelection(selection, hash).join(",") });
	}

	return (
		<>
			<ConfigPicker items={items} facets={facets} selected={selection} onToggle={toggle} />

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
					.with({ status: "success" }, (q) => {
						// Split over the compared groups, not `items`: a column's label
						// only has to separate it from the other columns on screen, and
						// what distinguishes four selected configs is usually far shorter
						// than what distinguishes all forty. Derived once here so the
						// chips and every grid label the same config the same way —
						// same reason `ConfigList` takes its facets from this component.
						const comparedFacets = splitConfigFacets(q.data.groups);
						return (
							<div className="space-y-8">
								<ConfigChips
									groups={q.data.groups}
									facets={comparedFacets}
									// The selection the server computed these numbers under, so the
									// drill-down explains the number on the card rather than
									// recomputing a different one.
									replaySelection={q.data.replay_selection}
									onRemove={toggle}
								/>
								<CoverageNotice
									comparison={q.data}
									scope={scope}
									onChangeScope={(next) => setSearch({ scope: next })}
								/>
								{/* Per-conversation first: the aggregate table says which config
								    won on average, the grids say where it won and where it fell
								    over — and the second question is the one a debugger is for. */}
								{rankedMetricRows().map((row) => (
									<HeatGrid key={row.key} comparison={q.data} row={row} facets={comparedFacets} />
								))}
								<details className="group">
									<summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground">
										All metrics, aggregated
									</summary>
									<div className="mt-4">
										<MetricsMatrix comparison={q.data} />
									</div>
								</details>
							</div>
						);
					})
					.exhaustive()
			)}
		</>
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
 * One group exists — the state a dev is in right after their first labelled
 * run. Naming the config they already have is what makes it read as progress
 * rather than as the empty page again.
 */
function OneConfigState({ item }: { item: RunConfigSummary }) {
	return (
		<div className="rounded-lg border border-dashed border-border/60 px-6 py-16 text-center">
			<p className="mx-auto max-w-md text-sm text-muted-foreground">
				Only one run config so far —{" "}
				<span className="font-medium text-foreground">
					{runConfigLabel(item.name, item.config, item.hash)}
				</span>
				, over {item.coverage.conversations} conversation
				{item.coverage.conversations === 1 ? "" : "s"}. Run your suite again under a second{" "}
				<code className="font-mono text-xs">RunConfig(...)</code> and the two show up here side by
				side.
			</p>
		</div>
	);
}
