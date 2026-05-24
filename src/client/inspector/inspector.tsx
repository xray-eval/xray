import { skipToken, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { BackLink } from "@/client/components/back-link.tsx";
import { Breadcrumbs } from "@/client/components/breadcrumbs.tsx";
import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import { shortHash } from "@/client/format.ts";

import { getConversation, getReplay, replayAudioUrl } from "../api/api.ts";
import type {
	ModelUsageResponse,
	ReplayDetailResponse,
	SpanResponse,
	ToolCallResponse,
} from "../api/api.types.ts";
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
				<div className="space-y-1.5">
					<h2 className="text-2xl font-semibold tracking-tight">Replay</h2>
					<p className="font-mono text-xs text-muted-foreground">{replayId}</p>
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
		<div className="grid gap-6 lg:grid-cols-3">
			<div className="grid gap-6 lg:col-span-2">
				<HeaderCard replay={replay} />
				<TurnsCard replay={replay} />
				<SpansCard spans={replay.spans} />
			</div>
			<aside className="grid gap-6">
				<RunConfigCard replay={replay} />
				<ToolCallsCard toolCalls={replay.tool_calls} />
				<ModelUsageCard usage={replay.model_usage} />
			</aside>
		</div>
	);
}

function TurnsCard({ replay }: { replay: ReplayDetailResponse }) {
	if (replay.audio_path === null) {
		return (
			<Card className="gap-4">
				<CardHeader>
					<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
						Turns
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">
						Awaiting audio upload. Server-side VAD analysis populates turns after the stereo WAV
						lands.
					</p>
				</CardContent>
			</Card>
		);
	}
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Turns
				</CardTitle>
			</CardHeader>
			<CardContent>
				<StereoTurnPlayer audioUrl={replayAudioUrl(replay.id)} turns={replay.turns} />
			</CardContent>
		</Card>
	);
}

function SpansCard({ spans }: { spans: SpanResponse[] }) {
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Span tree
				</CardTitle>
			</CardHeader>
			<CardContent>
				{spans.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No trace spans recorded. Decorate your agent code with{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
							@xray.trace.stage(...)
						</code>{" "}
						to populate this panel — see <code className="font-mono text-xs">docs/SDK.md</code>.
					</p>
				) : (
					<ul className="grid gap-2 text-xs">
						{spans.map((s) => (
							<li
								key={s.id}
								className="rounded-md border border-border/60 bg-muted/20 p-2.5 font-mono"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="truncate">{s.name}</span>
									<Badge variant="outline" className="shrink-0 font-normal">
										{s.vocabulary}
									</Badge>
								</div>
								<div className="mt-1 text-muted-foreground tabular-nums">
									{formatTimestamp(s.started_at)} → {formatTimestamp(s.ended_at)}
								</div>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

function RunConfigCard({ replay }: { replay: ReplayDetailResponse }) {
	if (replay.run_config === null || replay.run_config === undefined) return null;
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Run config
				</CardTitle>
			</CardHeader>
			<CardContent>
				<pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/20 p-3 font-mono text-xs leading-relaxed">
					{JSON.stringify(replay.run_config, null, 2)}
				</pre>
			</CardContent>
		</Card>
	);
}

function ToolCallsCard({ toolCalls }: { toolCalls: ToolCallResponse[] }) {
	if (toolCalls.length === 0) return null;
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Tool calls
				</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="grid gap-2 text-xs">
					{toolCalls.map((tc) => (
						<li
							key={tc.id}
							className="rounded-md border border-border/60 bg-muted/20 p-2.5 font-mono"
						>
							<div className="font-medium">{tc.name}</div>
							{tc.args_json !== null && (
								<div className="mt-1 truncate text-muted-foreground">args: {tc.args_json}</div>
							)}
							{tc.result_json !== null && (
								<div className="truncate text-muted-foreground">result: {tc.result_json}</div>
							)}
							{tc.latency_ms !== null && (
								<div className="text-muted-foreground tabular-nums">{tc.latency_ms}ms</div>
							)}
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

function ModelUsageCard({ usage }: { usage: ModelUsageResponse[] }) {
	if (usage.length === 0) return null;
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Model usage
				</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="grid gap-2 text-xs">
					{usage.map((u) => (
						<li key={u.id} className="rounded-md border border-border/60 bg-muted/20 p-2.5">
							<div className="flex items-center justify-between gap-2">
								<span className="font-mono">{u.model ?? "(unknown)"}</span>
								<Badge variant="outline" className="font-normal">
									{u.provider ?? "?"}
								</Badge>
							</div>
							<div className="mt-1 text-muted-foreground tabular-nums">
								in: {u.input_tokens ?? "?"} · out: {u.output_tokens ?? "?"} · total:{" "}
								{u.total_tokens ?? "?"}
							</div>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

function HeaderCard({ replay }: { replay: ReplayDetailResponse }) {
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
					<span>Status</span>
					<RunStatusBadge replay={replay} />
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-1.5 text-sm text-muted-foreground tabular-nums">
				<div>Started {formatTimestamp(replay.started_at)}</div>
				{replay.finished_at !== null && <div>Finished {formatTimestamp(replay.finished_at)}</div>}
			</CardContent>
		</Card>
	);
}
