import { skipToken, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { match } from "ts-pattern";

import { BackLink } from "@/client/components/back-link.tsx";
import { Breadcrumbs } from "@/client/components/breadcrumbs.tsx";
import { JsonOrText, JsonTree } from "@/client/components/json-tree.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from "@/client/components/ui/table.tsx";
import { shortHash } from "@/client/format.ts";
import { isJsonContainer } from "@/client/lib/json.ts";
import { cn } from "@/client/lib/utils.ts";
import { SpanDetailAside } from "@/client/trace-tree/span-detail/span-detail.tsx";
import { SpanSelectionProvider } from "@/client/trace-tree/span-selection.tsx";
import { TraceTree, ZoomControls } from "@/client/trace-tree/trace-tree.tsx";

import { getConversation, getReplay, replayAudioUrl } from "../api/api.ts";
import type {
	ModelUsageResponse,
	ReplayDetailResponse,
	ToolCallResponse,
} from "../api/api.types.ts";
import { PlayerProvider } from "../audio/player-provider.tsx";
import { StereoTurnPlayer } from "../audio/stereo-turn-player.tsx";
import { formatTimestamp } from "../format.ts";
import { RunStatusBadge } from "../replay-status/replay-status.tsx";

export function Inspector() {
	const { replayId } = useParams({ from: "/replays/$replayId" });
	const query = useQuery({
		queryKey: ["replays", { id: replayId }],
		queryFn: ({ signal }) => getReplay(replayId, signal),
	});

	const conversationHash = query.data?.conversation_hash;
	const conversation = useQuery({
		queryKey: ["conversations", { hash: conversationHash }],
		queryFn:
			conversationHash === undefined
				? skipToken
				: ({ signal }) => getConversation(conversationHash, signal),
	});
	const conversationLabel =
		conversation.data?.name ??
		(conversationHash !== undefined ? `${shortHash(conversationHash)}…` : null);

	return (
		<section className="space-y-10">
			<div className="space-y-5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					{conversationHash !== undefined ? (
						<BackLink to="/conversations/$conversationHash" params={{ conversationHash }}>
							Replays
						</BackLink>
					) : (
						<BackLink to="/">Conversations</BackLink>
					)}
					{conversationHash !== undefined && conversationLabel !== null ? (
						<Breadcrumbs
							crumbs={[
								{ label: "Conversations", to: "/" },
								{
									label: conversationLabel,
									to: "/conversations/$conversationHash",
									params: { conversationHash },
								},
								{ label: `${replayId.slice(0, 8)}…`, current: true },
							]}
						/>
					) : (
						<Breadcrumbs
							crumbs={[
								{ label: "Conversations", to: "/" },
								{ label: "Replay", current: true },
							]}
						/>
					)}
				</div>
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-3">
						<h2 className="text-2xl font-semibold tracking-tight">Replay</h2>
						{query.data && <RunStatusBadge replay={query.data} />}
					</div>
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums">
						<span>{replayId}</span>
						{query.data && (
							<>
								<span aria-hidden="true" className="text-border">
									·
								</span>
								<span>Started {formatTimestamp(query.data.started_at)}</span>
								{query.data.finished_at !== null && (
									<>
										<span aria-hidden="true" className="text-border">
											·
										</span>
										<span>Finished {formatTimestamp(query.data.finished_at)}</span>
									</>
								)}
							</>
						)}
					</div>
				</div>
			</div>

			{match(query)
				.with({ status: "pending" }, () => (
					<div role="status" aria-label="Loading replay" aria-busy="true">
						<Skeleton className="h-96 w-full" />
					</div>
				))
				.with({ status: "error" }, () => (
					<p role="alert" className="text-sm text-destructive">
						Failed to load replay.
					</p>
				))
				.with({ status: "success" }, (q) => <ReplayBody replay={q.data} />)
				.exhaustive()}
		</section>
	);
}

function ReplayBody({ replay }: { replay: ReplayDetailResponse }) {
	return (
		<PlayerProvider>
			<SpanSelectionProvider>
				<div className="grid gap-6 lg:grid-cols-3">
					<div className="lg:col-span-2 lg:col-start-1 lg:row-start-1">
						<AudioSection replay={replay} />
					</div>
					<div className="lg:col-span-2 lg:col-start-1 lg:row-start-2">
						<TraceCard replay={replay} />
					</div>
					<div className="relative lg:col-start-3 lg:row-start-1">
						<RunDetailsCard replay={replay} />
					</div>
					<aside className="relative lg:col-start-3 lg:row-start-2">
						<SpanDetailAside replay={replay} />
					</aside>
				</div>
			</SpanSelectionProvider>
		</PlayerProvider>
	);
}

function AudioSection({ replay }: { replay: ReplayDetailResponse }) {
	if (replay.audio_path === null) {
		return (
			<Card className="gap-0 overflow-hidden p-0">
				<CardHeader className="gap-0 border-b-[1px] border-border/60 px-5 py-4">
					<CardTitle className="text-base font-semibold tracking-tight text-foreground">
						Audio
					</CardTitle>
				</CardHeader>
				<CardContent className="px-5 py-4">
					<p className="text-sm text-muted-foreground">
						Awaiting audio upload. Server-side VAD analysis populates turns after the stereo WAV
						lands.
					</p>
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="space-y-3">
			<StereoTurnPlayer audioUrl={replayAudioUrl(replay.id)} turns={replay.turns} />
			{replay.turns.length === 0 && (
				<p className="text-xs text-muted-foreground">
					Audio uploaded. Server-side VAD analysis hasn't published turns yet. They'll appear on the
					waveform once analysis completes.
				</p>
			)}
		</div>
	);
}

function TraceCard({ replay }: { replay: ReplayDetailResponse }) {
	const [zoom, setZoom] = useState(1);
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<CardHeader className="gap-0 border-b-[1px] border-border/60 px-5 py-4">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-baseline gap-3">
						<CardTitle className="text-base font-semibold tracking-tight text-foreground">
							Span tree
						</CardTitle>
						<span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
							{replay.turns.length} {replay.turns.length === 1 ? "turn" : "turns"} ·{" "}
							{replay.spans.length} {replay.spans.length === 1 ? "span" : "spans"}
						</span>
					</div>
					{replay.spans.length > 0 && <ZoomControls zoom={zoom} onChange={setZoom} />}
				</div>
			</CardHeader>
			<CardContent className="h-[560px] px-0 py-0">
				<TraceTree
					turns={replay.turns}
					spans={replay.spans}
					replayStartIso={replay.started_at}
					zoom={zoom}
				/>
			</CardContent>
		</Card>
	);
}

function RunDetailsCard({ replay }: { replay: ReplayDetailResponse }) {
	const hasUsage = replay.model_usage.length > 0;
	const hasTools = replay.tool_calls.length > 0;
	const hasConfig = replay.run_config !== null && replay.run_config !== undefined;
	if (!hasUsage && !hasTools && !hasConfig) return null;
	return (
		<Card className="gap-0 overflow-hidden p-0 lg:absolute lg:inset-0 lg:flex lg:flex-col">
			<CardHeader className="gap-0 border-b-[1px] border-border/60 px-5 py-4 lg:shrink-0">
				<CardTitle className="text-base font-semibold tracking-tight text-foreground">
					Run details
				</CardTitle>
			</CardHeader>
			<CardContent className="scroll-panel divide-y divide-border/50 p-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
				{hasUsage && <ModelUsageSection usage={replay.model_usage} />}
				{hasTools && <ToolCallsSection toolCalls={replay.tool_calls} />}
				{hasConfig && <RunConfigSection runConfig={replay.run_config} />}
			</CardContent>
		</Card>
	);
}

function SectionHeader({ label, meta }: { label: string; meta?: string | null }) {
	return (
		<div className="mb-3 flex items-baseline justify-between gap-3">
			<h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-foreground/70">
				{label}
			</h3>
			{meta !== null && meta !== undefined && (
				<span className="font-mono text-[10px] tracking-wide text-muted-foreground/70 tabular-nums">
					{meta}
				</span>
			)}
		</div>
	);
}

function ModelUsageSection({ usage }: { usage: ModelUsageResponse[] }) {
	const totals = usage.reduce(
		(acc, u) => ({
			input: acc.input + (u.input_tokens ?? 0),
			output: acc.output + (u.output_tokens ?? 0),
			total: acc.total + (u.total_tokens ?? 0),
		}),
		{ input: 0, output: 0, total: 0 },
	);
	const showTotalRow = usage.length > 1;
	return (
		<section className="px-5 py-4">
			<SectionHeader
				label="Model usage"
				meta={`${usage.length} call${usage.length === 1 ? "" : "s"}`}
			/>
			<Table className="w-full table-fixed font-mono text-xs tabular-nums">
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className={cn(USAGE_HEAD, "pl-0")}>model</TableHead>
						<TableHead className={cn(USAGE_HEAD, "w-12 text-right")}>in</TableHead>
						<TableHead className={cn(USAGE_HEAD, "w-12 text-right")}>out</TableHead>
						<TableHead className={cn(USAGE_HEAD, "w-14 pr-0 text-right")}>total</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{usage.map((u) => (
						<TableRow key={u.id} className="border-border/40">
							<TableCell className="overflow-hidden pl-0">
								<div className="truncate">
									<span className="text-foreground">{u.model ?? "—"}</span>
									{u.provider !== null && (
										<span className="ml-1.5 text-muted-foreground">/{u.provider}</span>
									)}
								</div>
							</TableCell>
							<TableCell className="text-right text-foreground/80">
								{formatTokens(u.input_tokens)}
							</TableCell>
							<TableCell className="text-right text-foreground/80">
								{formatTokens(u.output_tokens)}
							</TableCell>
							<TableCell className="pr-0 text-right font-semibold text-foreground">
								{formatTokens(u.total_tokens)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
				{showTotalRow && (
					<TableFooter className="bg-transparent">
						<TableRow className="border-t border-border/40 hover:bg-transparent">
							<TableCell className="pl-0 text-[10px] uppercase tracking-wider text-muted-foreground">
								Total
							</TableCell>
							<TableCell className="text-right text-foreground/80">
								{totals.input.toLocaleString()}
							</TableCell>
							<TableCell className="text-right text-foreground/80">
								{totals.output.toLocaleString()}
							</TableCell>
							<TableCell className="pr-0 text-right text-foreground">
								{totals.total.toLocaleString()}
							</TableCell>
						</TableRow>
					</TableFooter>
				)}
			</Table>
		</section>
	);
}

const USAGE_HEAD = "h-7 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-normal";

function formatTokens(value: number | null): string {
	return value === null ? "—" : value.toLocaleString();
}

function ToolCallsSection({ toolCalls }: { toolCalls: ToolCallResponse[] }) {
	return (
		<section className="px-5 py-4">
			<SectionHeader label="Tool calls" meta={`${toolCalls.length}`} />
			<ul className="space-y-2.5">
				{toolCalls.map((tc) => (
					<li key={tc.id} className="font-mono text-xs">
						<div className="flex items-baseline justify-between gap-3">
							<span className="truncate font-medium text-foreground">{tc.name}</span>
							{tc.latency_ms !== null && (
								<span className="shrink-0 tabular-nums text-muted-foreground">
									{tc.latency_ms}ms
								</span>
							)}
						</div>
						{(tc.args_json !== null || tc.result_json !== null) && (
							<dl className="mt-1 space-y-1 border-l border-border/40 pl-2.5 text-[11px] text-muted-foreground">
								{tc.args_json !== null && <ToolCallJsonField label="Args" raw={tc.args_json} />}
								{tc.result_json !== null && (
									<ToolCallJsonField label="Result" raw={tc.result_json} />
								)}
							</dl>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

function ToolCallJsonField({ label, raw }: { label: string; raw: string }) {
	return (
		<div className="flex gap-2">
			<dt className="shrink-0 text-muted-foreground/60">{label}</dt>
			<dd className="min-w-0 flex-1 overflow-auto">
				<JsonOrText raw={raw} />
			</dd>
		</div>
	);
}

function RunConfigSection({ runConfig }: { runConfig: unknown }) {
	return (
		<section className="px-5 py-4">
			<SectionHeader label="Run config" />
			{isJsonContainer(runConfig) ? (
				<div className="max-h-64 overflow-auto rounded-md border border-border/40 bg-muted/30 p-3">
					<JsonTree data={runConfig} expandLevel={2} />
				</div>
			) : (
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/40 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
					{JSON.stringify(runConfig)}
				</pre>
			)}
		</section>
	);
}
