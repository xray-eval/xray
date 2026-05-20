import { skipToken, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertTriangle, Check, X } from "lucide-react";
import { match } from "ts-pattern";

import { BackLink } from "@/client/components/back-link.tsx";
import { Breadcrumbs } from "@/client/components/breadcrumbs.tsx";
import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { getConversation, getReplay, replayAudioUrl, turnAudioUrl } from "../api/api.ts";
import type {
	AssertionResponse,
	ModelUsageResponse,
	ReplayDetailResponse,
	ReplayTurnResponse,
	SpanResponse,
	ToolCallResponse,
} from "../api/api.types.ts";
import { AudioWithCaptions } from "../audio/audio-with-captions.tsx";
import { formatTimestamp } from "../format.ts";
import { JudgeStatusBadge, RunStatusBadge } from "../replay-status/replay-status.tsx";

export function Inspector() {
	const { replayId } = useParams({ from: "/replays/$replayId" });
	const query = useQuery({
		queryKey: ["replays", { id: replayId }],
		queryFn: ({ signal }) => getReplay(replayId, signal),
	});

	const conversationId = query.data?.conversation_id;
	const conversation = useQuery({
		queryKey: ["conversations", { id: conversationId }],
		queryFn:
			conversationId === undefined
				? skipToken
				: ({ signal }) => getConversation(conversationId, { signal }),
	});
	const conversationLabel =
		conversation.data?.title ?? (conversationId !== undefined ? conversationId : null);

	return (
		<section className="space-y-10">
			<div className="space-y-5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					{conversationId !== undefined ? (
						<BackLink to="/conversations/$conversationId" params={{ conversationId }}>
							Replays
						</BackLink>
					) : (
						<BackLink to="/">Conversations</BackLink>
					)}
					{conversationId !== undefined && conversationLabel !== null ? (
						<Breadcrumbs
							crumbs={[
								{ label: "Conversations", to: "/" },
								{
									label: conversationLabel,
									to: "/conversations/$conversationId",
									params: { conversationId },
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
				<TranscriptCard replay={replay} />
				<SpansCard spans={replay.spans} />
			</div>
			<aside className="grid gap-6">
				<JudgeCard replay={replay} />
				<RunConfigCard replay={replay} />
				<ToolCallsCard toolCalls={replay.tool_calls} />
				<ModelUsageCard usage={replay.model_usage} />
				<AssertionsCard assertions={replay.assertions} />
			</aside>
		</div>
	);
}

function TranscriptCard({ replay }: { replay: ReplayDetailResponse }) {
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Turns
				</CardTitle>
			</CardHeader>
			<CardContent>
				{replay.turns.length === 0 ? (
					<p className="text-sm text-muted-foreground">No per-turn data recorded.</p>
				) : (
					<ol className="grid gap-3">
						{replay.turns.map((turn) => (
							<li key={`${turn.idx}-${turn.role}`}>
								<TurnBlock
									replay={replay}
									turn={turn}
									assertions={replay.assertions.filter((a) => a.turn_idx === turn.idx)}
								/>
							</li>
						))}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}

function TurnBlock({
	replay,
	turn,
	assertions,
}: {
	replay: ReplayDetailResponse;
	turn: ReplayTurnResponse;
	assertions: AssertionResponse[];
}) {
	return (
		<div className="rounded-md border border-border/60 bg-muted/20 p-4">
			<div className="mb-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<Badge variant={turn.role === "user" ? "secondary" : "default"} className="font-normal">
					{turn.role}
				</Badge>
				<span className="font-mono">#{turn.idx}</span>
				{turn.key !== null && (
					<span className="font-mono">
						<span className="text-muted-foreground/60">key:</span> {turn.key}
					</span>
				)}
				{turn.started_at !== null && (
					<span className="tabular-nums">· {formatTimestamp(turn.started_at)}</span>
				)}
			</div>
			{turn.transcript !== null && (
				<p className="whitespace-pre-wrap text-sm leading-relaxed">{turn.transcript}</p>
			)}
			{turn.audio_path !== null && (
				<div className="mt-3">
					<AudioWithCaptions
						src={turnAudioUrl(replay.id, turn.idx)}
						captionText={turn.transcript}
						className="w-full"
						label={`Turn ${turn.idx} audio — ${turn.role}`}
					/>
				</div>
			)}
			{assertions.length > 0 && (
				<ul className="mt-3 grid gap-1.5 text-xs" aria-label={`Assertions for turn ${turn.idx}`}>
					{assertions.map((a) => (
						<li key={a.id} className="flex items-start gap-2">
							<AssertionChip status={a.status} />
							<div className="flex-1">
								<span className="font-medium">{a.name}</span>
								{a.message !== null && (
									<span className="ml-1 text-muted-foreground">— {a.message}</span>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function AssertionChip({ status }: { status: AssertionResponse["status"] }) {
	return match(status)
		.with("passed", () => (
			<Badge aria-label="passed" className="bg-success text-success-foreground">
				<Check className="size-3" strokeWidth={3} aria-hidden />
			</Badge>
		))
		.with("failed", () => (
			<Badge variant="destructive" aria-label="failed">
				<X className="size-3" strokeWidth={3} aria-hidden />
			</Badge>
		))
		.with("errored", () => (
			<Badge aria-label="errored" className="bg-warning text-warning-foreground">
				<AlertTriangle className="size-3" strokeWidth={2.5} aria-hidden />
			</Badge>
		))
		.exhaustive();
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

function JudgeCard({ replay }: { replay: ReplayDetailResponse }) {
	if (replay.judge.status === null) return null;
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Judge
				</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-2.5 text-sm">
				<JudgeStatusBadge status={replay.judge.status} score={replay.judge.score} />
				{replay.judge.reason !== null && (
					<p className="text-sm leading-relaxed text-muted-foreground">{replay.judge.reason}</p>
				)}
				{replay.judge.error !== null && (
					<p className="text-sm text-destructive">errored: {replay.judge.error}</p>
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
				<pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 font-mono text-xs leading-relaxed">
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

function AssertionsCard({ assertions }: { assertions: AssertionResponse[] }) {
	if (assertions.length === 0) return null;
	const passed = assertions.filter((a) => a.status === "passed").length;
	const failed = assertions.filter((a) => a.status === "failed").length;
	const errored = assertions.filter((a) => a.status === "errored").length;
	return (
		<Card className="gap-4">
			<CardHeader>
				<CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
					Assertions
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<Badge
						aria-label={`${passed} passed`}
						className="bg-success tabular-nums text-success-foreground"
					>
						<Check className="size-3" strokeWidth={3} aria-hidden /> {passed}
					</Badge>
					<Badge variant="destructive" aria-label={`${failed} failed`} className="tabular-nums">
						<X className="size-3" strokeWidth={3} aria-hidden /> {failed}
					</Badge>
					<Badge
						aria-label={`${errored} errored`}
						className="bg-warning tabular-nums text-warning-foreground"
					>
						<AlertTriangle className="size-3" strokeWidth={2.5} aria-hidden /> {errored}
					</Badge>
				</div>
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
				{replay.audio_path !== null && (
					<div className="mt-4">
						<AudioWithCaptions
							src={replayAudioUrl(replay.id)}
							captionText={replay.transcript}
							className="w-full"
							label="Full replay audio"
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
