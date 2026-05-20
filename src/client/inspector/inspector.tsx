import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { match } from "ts-pattern";

import { Badge } from "@/client/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";

import { getReplay, replayAudioUrl, turnAudioUrl } from "../api/api.ts";
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

export function Inspector() {
	const { replayId } = useParams({ from: "/replays/$replayId" });
	const query = useQuery({
		queryKey: ["replays", { id: replayId }],
		queryFn: ({ signal }) => getReplay(replayId, signal),
	});

	const conversationId = query.data?.conversation_id;
	return (
		<section>
			<header className="mb-6 flex items-center justify-between">
				<div>
					{conversationId !== undefined ? (
						<Link
							to="/conversations/$conversationId"
							params={{ conversationId }}
							className="text-sm text-muted-foreground hover:underline"
						>
							<span aria-hidden="true">←</span> Conversation
						</Link>
					) : (
						<Link to="/" className="text-sm text-muted-foreground hover:underline">
							<span aria-hidden="true">←</span> Conversations
						</Link>
					)}
					<h2 className="mt-2 text-2xl font-semibold">Replay</h2>
					<p className="font-mono text-xs text-muted-foreground">{replayId}</p>
				</div>
			</header>

			{match(query)
				.with({ status: "pending" }, () => (
					<div role="status" aria-label="Loading replay" aria-busy="true">
						<Skeleton className="h-96 w-full" />
					</div>
				))
				.with({ status: "error" }, () => (
					<p role="alert" className="text-destructive">
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
			<div className="lg:col-span-2 grid gap-6">
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
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Turns</CardTitle>
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
		<div className="rounded border p-3">
			<div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
				<Badge variant={turn.role === "user" ? "secondary" : "default"}>{turn.role}</Badge>
				<span>#{turn.idx}</span>
				{turn.key !== null && <span>key: {turn.key}</span>}
				{turn.started_at !== null && <span>· {formatTimestamp(turn.started_at)}</span>}
			</div>
			{turn.transcript !== null && <p className="whitespace-pre-wrap text-sm">{turn.transcript}</p>}
			{turn.audio_path !== null && (
				<div className="mt-2">
					<AudioWithCaptions
						src={turnAudioUrl(replay.id, turn.idx)}
						captionText={turn.transcript}
						className="w-full"
						label={`Turn ${turn.idx} audio — ${turn.role}`}
					/>
				</div>
			)}
			{assertions.length > 0 && (
				<ul className="mt-2 grid gap-1 text-xs" aria-label={`Assertions for turn ${turn.idx}`}>
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
		.with("passed", () => <Badge aria-label="passed">{"✓"}</Badge>)
		.with("failed", () => (
			<Badge variant="destructive" aria-label="failed">
				{"✗"}
			</Badge>
		))
		.with("errored", () => (
			<Badge variant="secondary" aria-label="errored">
				err
			</Badge>
		))
		.exhaustive();
}

function SpansCard({ spans }: { spans: SpanResponse[] }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Span tree</CardTitle>
			</CardHeader>
			<CardContent>
				{spans.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No trace spans recorded. Decorate your agent code with{" "}
						<code>@xray.trace.stage(...)</code> to populate this panel — see{" "}
						<code>docs/SDK.md</code>.
					</p>
				) : (
					<ul className="grid gap-2 text-xs">
						{spans.map((s) => (
							<li key={s.id} className="rounded border p-2 font-mono">
								<div className="flex items-center justify-between">
									<span className="truncate">{s.name}</span>
									<Badge variant="outline">{s.vocabulary}</Badge>
								</div>
								<div className="text-muted-foreground">
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
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Judge</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-2 text-sm">
				<div>
					<Badge>{replay.judge.status}</Badge>
					{replay.judge.score !== null && <span className="ml-2">score: {replay.judge.score}</span>}
				</div>
				{replay.judge.reason !== null && (
					<p className="text-muted-foreground">{replay.judge.reason}</p>
				)}
				{replay.judge.error !== null && (
					<p className="text-destructive">errored: {replay.judge.error}</p>
				)}
			</CardContent>
		</Card>
	);
}

function RunConfigCard({ replay }: { replay: ReplayDetailResponse }) {
	if (replay.run_config === null || replay.run_config === undefined) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Run config</CardTitle>
			</CardHeader>
			<CardContent>
				<pre className="overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
					{JSON.stringify(replay.run_config, null, 2)}
				</pre>
			</CardContent>
		</Card>
	);
}

function ToolCallsCard({ toolCalls }: { toolCalls: ToolCallResponse[] }) {
	if (toolCalls.length === 0) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Tool calls</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="grid gap-2 text-xs">
					{toolCalls.map((tc) => (
						<li key={tc.id} className="rounded border p-2 font-mono">
							<div className="font-medium">{tc.name}</div>
							{tc.args_json !== null && (
								<div className="text-muted-foreground truncate">args: {tc.args_json}</div>
							)}
							{tc.result_json !== null && (
								<div className="text-muted-foreground truncate">result: {tc.result_json}</div>
							)}
							{tc.latency_ms !== null && (
								<div className="text-muted-foreground">{tc.latency_ms}ms</div>
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
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Model usage</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="grid gap-2 text-xs">
					{usage.map((u) => (
						<li key={u.id} className="rounded border p-2">
							<div className="flex items-center justify-between">
								<span className="font-mono">{u.model ?? "(unknown)"}</span>
								<Badge variant="outline">{u.provider ?? "?"}</Badge>
							</div>
							<div className="text-muted-foreground">
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
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Assertions</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<Badge aria-label={`${passed} passed`}>
						{passed} {"✓"}
					</Badge>
					<span className="text-muted-foreground">·</span>
					<Badge variant="destructive" aria-label={`${failed} failed`}>
						{failed} {"✗"}
					</Badge>
					<span className="text-muted-foreground">·</span>
					<Badge variant="secondary" aria-label={`${errored} errored`}>
						{errored} err
					</Badge>
				</div>
			</CardContent>
		</Card>
	);
}

function HeaderCard({ replay }: { replay: ReplayDetailResponse }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-3 text-base">
					<span>Status</span>
					{match(replay.status)
						.with("running", () => <Badge variant="secondary">running</Badge>)
						.with("completed", () => <Badge>completed</Badge>)
						.with("failed", () => (
							<Badge variant="destructive" title={replay.failure_reason ?? ""}>
								failed{replay.failure_reason !== null ? `: ${replay.failure_reason}` : ""}
							</Badge>
						))
						.exhaustive()}
				</CardTitle>
			</CardHeader>
			<CardContent className="text-sm text-muted-foreground">
				<div>Started {formatTimestamp(replay.started_at)}</div>
				{replay.finished_at !== null && <div>Finished {formatTimestamp(replay.finished_at)}</div>}
				{replay.audio_path !== null && (
					<div className="mt-3">
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
