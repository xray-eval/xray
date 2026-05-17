import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ChevronRight, Play, Zap, ZapOff } from "lucide-react";
import { useState } from "react";
import { match } from "ts-pattern";

import type {
	Conversation,
	ConversationToolCall,
	ConversationTurn,
} from "@/server/sessions/sessions.types.ts";

import { fetchConversation } from "../api/conversation-api.ts";
import { TurnAudio } from "../audio/turn-audio.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card.tsx";
import { Separator } from "../components/ui/separator.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { formatAbsolute, formatDuration } from "../format.ts";
import { ReplayModal } from "../replays/replay-modal.tsx";
import { BackToSessionsLink } from "../router/back-to-sessions-link.tsx";
import { sourceBadgeVariant } from "../source-badge.ts";
import { ConversationLoadError } from "./errors.ts";

const route = getRouteApi("/sessions/$sessionId");

type ConversationQueryKey = readonly ["conversation", { sessionId: string }];

export function Inspector() {
	const { sessionId } = route.useParams();
	const navigate = useNavigate();
	const [replayOpen, setReplayOpen] = useState(false);
	const query = useQuery<Conversation, Error, Conversation, ConversationQueryKey>({
		queryKey: ["conversation", { sessionId }] as const,
		queryFn: ({ signal }) => fetchConversation({ sessionId, signal }),
	});

	return (
		<>
			<section
				aria-label="Transcript"
				aria-busy={query.isPending}
				aria-live="polite"
				className="space-y-6"
			>
				<header className="flex items-baseline justify-between gap-4">
					<BackToSessionsLink />
					{query.status === "success" && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setReplayOpen(true)}
							aria-label={`Replay session ${query.data.agentId}`}
						>
							<Play />
							Replay
						</Button>
					)}
				</header>

				{match(query)
					.with({ status: "pending" }, () => <LoadingState />)
					.with({ status: "error" }, (q) => (
						<ErrorState error={q.error} onRetry={() => query.refetch()} />
					))
					.with({ status: "success" }, (q) => <Transcript conversation={q.data} />)
					.exhaustive()}
			</section>
			{replayOpen && (
				<ReplayModal
					sourceSessionId={sessionId}
					onClose={() => setReplayOpen(false)}
					onStarted={(run) => {
						setReplayOpen(false);
						void navigate({ to: "/replays/$replayId", params: { replayId: run.id } });
					}}
				/>
			)}
		</>
	);
}

function Transcript({ conversation }: { conversation: Conversation }) {
	return (
		<div className="space-y-6">
			<TranscriptHeader conversation={conversation} />
			<Separator />
			{conversation.turns.length === 0 ? (
				<EmptyTranscript />
			) : (
				<ol className="space-y-4">
					{conversation.turns.map((turn) => (
						<li key={turn.id}>
							<TurnCard sessionId={conversation.id} turn={turn} />
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

function TranscriptHeader({ conversation }: { conversation: Conversation }) {
	return (
		<div className="space-y-2">
			<h2 className="text-2xl font-semibold tracking-tight">{conversation.agentId}</h2>
			<dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-sm">
				<div className="flex items-baseline gap-2">
					<dt className="text-muted-foreground">Session</dt>
					<dd className="font-mono">{conversation.id}</dd>
				</div>
				<div className="flex items-baseline gap-2">
					<dt className="text-muted-foreground">Started</dt>
					<dd>
						<time dateTime={conversation.startedAt}>{formatAbsolute(conversation.startedAt)}</time>
					</dd>
				</div>
				<div className="flex items-baseline gap-2">
					<dt className="text-muted-foreground">Duration</dt>
					<dd>{formatDuration(conversation.durationMs)}</dd>
				</div>
				<div className="flex items-baseline gap-2">
					<dt className="sr-only">Source</dt>
					<dd>
						<Badge variant={sourceBadgeVariant(conversation.source)}>{conversation.source}</Badge>
					</dd>
				</div>
			</dl>
		</div>
	);
}

function TurnCard({ sessionId, turn }: { sessionId: string; turn: ConversationTurn }) {
	const interruptedSuffix = turn.interruptedAtMs !== null ? ` at ${turn.interruptedAtMs}ms` : "";
	return (
		<Card>
			<CardHeader>
				<CardDescription className="flex flex-wrap items-center gap-2">
					<RoleBadge role={turn.role} />
					<time dateTime={turn.timestamp} className="text-muted-foreground text-xs">
						{formatAbsolute(turn.timestamp)}
					</time>
					{turn.responseLatencyMs !== null && (
						<Badge variant="outline" aria-label={`Response latency ${turn.responseLatencyMs}ms`}>
							<Zap />
							{turn.responseLatencyMs}ms
						</Badge>
					)}
					{turn.interrupted === true && (
						<Badge variant="destructive" aria-label={`Interrupted${interruptedSuffix}`}>
							<ZapOff />
							interrupted{interruptedSuffix}
						</Badge>
					)}
				</CardDescription>
				<CardTitle className="text-base font-medium whitespace-pre-wrap break-words">
					{turn.text}
				</CardTitle>
				{turn.audioPath !== null && <TurnAudio sessionId={sessionId} turn={turn} />}
			</CardHeader>
			{turn.toolCalls.length > 0 && (
				<CardContent>
					<ToolCallList toolCalls={turn.toolCalls} />
				</CardContent>
			)}
		</Card>
	);
}

function RoleBadge({ role }: { role: ConversationTurn["role"] }) {
	const variant: "default" | "secondary" | "outline" = match(role)
		.with("agent", () => "default" as const)
		.with("user", () => "secondary" as const)
		.with("tool", () => "outline" as const)
		.with("system", () => "outline" as const)
		.exhaustive();
	return <Badge variant={variant}>{role}</Badge>;
}

function ToolCallList({ toolCalls }: { toolCalls: readonly ConversationToolCall[] }) {
	return (
		<ul className="space-y-2">
			{toolCalls.map((call) => (
				<li key={call.idx}>
					<ToolCallBlock call={call} />
				</li>
			))}
		</ul>
	);
}

function ToolCallBlock({ call }: { call: ConversationToolCall }) {
	return (
		<details className="group rounded-md border border-border bg-muted/30 p-3 text-sm">
			<summary className="flex cursor-pointer items-center gap-2 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-4 transition-transform group-open:rotate-90" />
				<span className="font-mono">{call.name}</span>
				{call.latencyMs !== null && (
					<Badge variant="outline" className="ml-auto">
						{call.latencyMs}ms
					</Badge>
				)}
			</summary>
			<div className="mt-3 space-y-3 pl-6">
				<ToolCallField label="args" value={call.args} />
				<ToolCallField label="result" value={call.result} />
			</div>
		</details>
	);
}

function ToolCallField({ label, value }: { label: string; value: unknown }) {
	return (
		<div className="space-y-1">
			<div className="text-muted-foreground text-xs uppercase tracking-wider">{label}</div>
			<pre className="overflow-x-auto rounded bg-background p-2 font-mono text-xs">
				{prettyPrintJson(value)}
			</pre>
		</div>
	);
}

function LoadingState() {
	return (
		<div className="space-y-4">
			<span className="sr-only">Loading transcript…</span>
			<div aria-hidden="true" className="space-y-4">
				<Skeleton className="h-7 w-48" />
				<Skeleton className="h-4 w-72" />
				<Separator />
				{[0, 1, 2].map((i) => (
					<Card key={i}>
						<CardHeader>
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-4 w-64" />
						</CardHeader>
					</Card>
				))}
			</div>
		</div>
	);
}

interface ErrorStateProps {
	error: Error;
	onRetry: () => void;
}

function ErrorState({ error, onRetry }: ErrorStateProps) {
	const notFound = error instanceof ConversationLoadError && error.status === 404;
	return (
		// role="alert" on the whole card so SR announces title + description
		// together when the error mounts — not just the retry footer.
		<Card role="alert">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<AlertCircle className="text-destructive size-4" />
					{notFound ? "Session not found." : "Failed to load transcript."}
				</CardTitle>
				<CardDescription className="break-all">
					{notFound
						? "The session id may have been removed or never existed. Go back to the list and pick another."
						: error.message}
				</CardDescription>
			</CardHeader>
			{!notFound && (
				<CardContent className="flex justify-end">
					<Button size="sm" variant="outline" onClick={onRetry}>
						Try again
					</Button>
				</CardContent>
			)}
		</Card>
	);
}

function EmptyTranscript() {
	return (
		<Card>
			<CardHeader className="items-center text-center">
				<CardTitle>No turns yet.</CardTitle>
				<CardDescription>
					This session has metadata but no recorded turns. POST a <code>turn_completed</code> event
					to populate it.
				</CardDescription>
			</CardHeader>
		</Card>
	);
}

function prettyPrintJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}
