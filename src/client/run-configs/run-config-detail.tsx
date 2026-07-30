import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { getRunConfigDetail } from "@/client/api/api.ts";
import type {
	ReplaySelection,
	RunConfigConversationRow,
	RunConfigDetailResponse,
} from "@/client/api/api.types.ts";
import { BackLink } from "@/client/components/back-link.tsx";
import { Breadcrumbs } from "@/client/components/breadcrumbs.tsx";
import { Badge } from "@/client/components/ui/badge.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import { formatTimestamp, shortHash } from "@/client/format.ts";

import { MetricCell } from "./metric-cell.tsx";
import { METRIC_ROWS } from "./metric-rows.ts";
import { ModeToggle } from "./mode-toggle.tsx";
import { runConfigLabel, runConfigPairs } from "./run-config-label.ts";

export function RunConfigDetail() {
	const { configHash } = useParams({ from: "/configs/$configHash" });
	const { replays } = useSearch({ from: "/configs/$configHash" });
	const replaySelection = replays ?? "latest";

	const query = useQuery({
		queryKey: ["run-configs", { hash: configHash, replaySelection }],
		queryFn: ({ signal }) => getRunConfigDetail(configHash, replaySelection, signal),
	});

	return (
		<section>
			<header className="mb-8 space-y-5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<BackLink to="/configs">Run configs</BackLink>
					<Breadcrumbs
						crumbs={[
							{ label: "Run configs", to: "/configs" },
							{ label: "Config detail", current: true },
						]}
					/>
				</div>
			</header>

			{match(query)
				.with({ status: "pending" }, () => (
					<div role="status" aria-label="Loading run config" aria-busy="true">
						<Skeleton className="h-96 w-full" />
					</div>
				))
				.with({ status: "error" }, () => (
					<p role="alert" className="text-sm text-destructive">
						Failed to load this run config.
					</p>
				))
				.with({ status: "success" }, (q) => (
					<DetailBody detail={q.data} replaySelection={replaySelection} />
				))
				.exhaustive()}
		</section>
	);
}

function DetailBody({
	detail,
	replaySelection,
}: {
	detail: RunConfigDetailResponse;
	replaySelection: ReplaySelection;
}) {
	const navigate = useNavigate();
	const pairs = runConfigPairs(detail.config);
	// What the metrics were actually computed over. Derived from the rows the
	// response already carries rather than a second server-side count.
	const includedReplays = detail.conversations.reduce((sum, row) => sum + row.replays.length, 0);
	return (
		<div className="space-y-8">
			<div className="space-y-3">
				<h2 className="text-2xl font-semibold tracking-tight">
					{runConfigLabel(detail.name, detail.config, detail.hash)}
				</h2>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
					<span>{shortHash(detail.hash)}…</span>
					<span>·</span>
					<span>
						{detail.coverage.conversations} conversation
						{detail.coverage.conversations === 1 ? "" : "s"}
					</span>
					<span>·</span>
					<span>
						{detail.coverage.replays} replay{detail.coverage.replays === 1 ? "" : "s"}
					</span>
					{detail.coverage.failed_replays > 0 && (
						<>
							<span>·</span>
							<span className="text-warning">{detail.coverage.failed_replays} failed</span>
						</>
					)}
				</div>
				{pairs.length > 0 && (
					<dl className="flex flex-wrap gap-2">
						{pairs.map((pair) => (
							<div
								key={pair.key}
								className="rounded border border-border/60 px-2 py-1 font-mono text-[11px]"
							>
								<dt className="inline text-muted-foreground">{pair.key}=</dt>
								<dd className="inline">{pair.value}</dd>
							</div>
						))}
					</dl>
				)}
			</div>

			<div className="space-y-3">
				<h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
					Across every conversation
				</h3>
				{/* The header above counts the whole group; these numbers are computed
				    over the selected subset. Silence when they're the same set — a
				    caveat that always shows is a caveat nobody reads. */}
				{includedReplays < detail.coverage.replays && (
					<p className="font-mono text-[11px] tabular-nums text-muted-foreground">
						{includedReplays} of {detail.coverage.replays} replays · {detail.conversations.length}{" "}
						of {detail.coverage.conversations} conversations
					</p>
				)}
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					{METRIC_ROWS.map((row) => (
						<div key={row.key} className="rounded-lg border border-border/60 p-3">
							<div className="mb-1 text-xs font-medium">{row.label}</div>
							<MetricCell cell={row.read(detail.metrics)} />
						</div>
					))}
				</div>
			</div>

			<div className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
						Per conversation
					</h3>
					<ModeToggle
						label="Replays"
						value={replaySelection}
						options={[
							{ value: "latest", label: "Latest per conversation" },
							{ value: "all", label: "All completed" },
						]}
						onChange={(value) =>
							void navigate({
								to: "/configs/$configHash",
								params: { configHash: detail.hash },
								search: { replays: value },
							})
						}
					/>
				</div>
				{detail.conversations.length === 0 ? (
					<p className="rounded-lg border border-dashed border-border/60 px-6 py-12 text-center text-sm text-muted-foreground">
						No completed replays under this config yet.
					</p>
				) : (
					<ul className="space-y-2">
						{detail.conversations.map((row) => (
							<ConversationRow key={row.conversation_hash} row={row} />
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

/**
 * One conversation this config ran. The whole point of the row is the link to
 * the inspector: an aggregate tells you *that* something is slow, the recording
 * tells you *why*. So the primary target is the newest replay for this
 * conversation — not a generic conversation page, which would lose the config
 * context. Earlier runs stay individually reachable below; the conversation spec
 * is reachable too, but secondary.
 */
function ConversationRow({ row }: { row: RunConfigConversationRow }) {
	const extraReplays = row.replays.slice(1);
	return (
		<li className="rounded-lg border border-border/60 p-4 transition-colors hover:border-border">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<Link
						to="/replays/$replayId"
						params={{ replayId: row.replay_id }}
						className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						{row.conversation_name}
					</Link>
					<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
						<Link
							to="/conversations/$conversationHash"
							params={{ conversationHash: row.conversation_hash }}
							className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							spec {shortHash(row.conversation_hash)}…
						</Link>
						{row.replays[0] !== undefined && (
							<>
								<span>·</span>
								<span>{formatTimestamp(row.replays[0].started_at)}</span>
							</>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					{row.replays[0]?.passed !== null && row.replays[0] !== undefined && (
						<Badge variant={row.replays[0].passed === true ? "default" : "destructive"}>
							{row.replays[0].passed === true ? "passed" : "failed"}
						</Badge>
					)}
					<Link
						to="/replays/$replayId"
						params={{ replayId: row.replay_id }}
						className="rounded-md border border-border/60 px-2.5 py-1 text-xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						Listen
					</Link>
				</div>
			</div>

			<div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
				{METRIC_ROWS.map((metricRow) => (
					<div key={metricRow.key}>
						<div className="mb-0.5 text-[11px] text-muted-foreground">{metricRow.label}</div>
						<MetricCell cell={metricRow.read(row.metrics)} />
					</div>
				))}
			</div>

			{extraReplays.length > 0 && (
				<details className="mt-3">
					<summary className="cursor-pointer font-mono text-[11px] text-muted-foreground hover:text-foreground">
						{extraReplays.length} earlier run{extraReplays.length === 1 ? "" : "s"}
					</summary>
					<ul className="mt-2 space-y-1">
						{extraReplays.map((replay) => (
							<li key={replay.id} className="flex items-center gap-2">
								<Link
									to="/replays/$replayId"
									params={{ replayId: replay.id }}
									className="rounded-sm font-mono text-[11px] tabular-nums underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
								>
									{formatTimestamp(replay.started_at)}
								</Link>
								{replay.passed !== null && (
									<span className="font-mono text-[10px] text-muted-foreground">
										{replay.passed ? "passed" : "failed"}
									</span>
								)}
							</li>
						))}
					</ul>
				</details>
			)}
		</li>
	);
}
