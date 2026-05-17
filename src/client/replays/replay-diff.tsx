import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, Zap, ZapOff } from "lucide-react";
import { match, P } from "ts-pattern";

import type { ReplayRunResponse } from "@/server/replays/replays.types.ts";
import type { Conversation, ConversationTurn } from "@/server/sessions/sessions.types.ts";

import { fetchConversation } from "../api/conversation-api.ts";
import { Badge } from "../components/ui/badge.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../components/ui/card.tsx";
import type {
	AnnotatedToolCall,
	DiffSummary,
	SummarySentence,
	ToolCallStatus,
	TurnDivergence,
} from "./diff/diff.ts";
import { alignTurns, divergencesFor, plural, summarize, summarySentence } from "./diff/diff.ts";

export interface DiffPanelProps {
	run: ReplayRunResponse;
}

type SessionQueryKey = readonly ["conversation", { sessionId: string }];

export function DiffPanel({ run }: DiffPanelProps) {
	const sourceQuery = useQuery<Conversation, Error, Conversation, SessionQueryKey>({
		queryKey: ["conversation", { sessionId: run.sourceSessionId }] as const,
		queryFn: ({ signal }) => fetchConversation({ sessionId: run.sourceSessionId, signal }),
	});
	const targetQuery = useQuery<Conversation, Error, Conversation, SessionQueryKey>({
		queryKey: ["conversation", { sessionId: run.targetSessionId }] as const,
		queryFn: ({ signal }) => fetchConversation({ sessionId: run.targetSessionId, signal }),
	});

	return match([sourceQuery, targetQuery] as const)
		.with([{ status: "error" }, P.any], [P.any, { status: "error" }], ([s, t]) => (
			<DiffError
				error={
					s.status === "error" ? s.error : t.status === "error" ? t.error : new Error("unknown")
				}
			/>
		))
		.with([{ status: "pending" }, P.any], [P.any, { status: "pending" }], () => <DiffLoading />)
		.with([{ status: "success" }, { status: "success" }], ([s, t]) => (
			<DiffBody source={s.data} target={t.data} />
		))
		.exhaustive();
}

function DiffBody({ source, target }: { source: Conversation; target: Conversation }) {
	const divergences = divergencesFor(alignTurns(source.turns, target.turns));
	const summary = summarize(divergences, source, target);
	const sentence = summarySentence(summary);
	return (
		<div className="space-y-4">
			<DiffSummaryCard summary={summary} sentence={sentence} />
			<div className="grid grid-cols-2 gap-3 text-xs font-medium text-muted-foreground">
				<div>Source</div>
				<div>Replay</div>
			</div>
			<ol className="space-y-3">
				{divergences.map(({ pair, divergence }) => (
					<li key={pair.idx} className="grid grid-cols-2 gap-3">
						<DiffCell
							turn={pair.source}
							annotatedTools={divergence.sourceToolCalls}
							divergence={divergence}
							side="source"
						/>
						<DiffCell
							turn={pair.target}
							annotatedTools={divergence.targetToolCalls}
							divergence={divergence}
							side="target"
						/>
					</li>
				))}
			</ol>
		</div>
	);
}

function DiffSummaryCard({
	summary,
	sentence,
}: {
	summary: DiffSummary;
	sentence: SummarySentence;
}) {
	const { Icon, iconClass } = match(sentence.tone)
		.with("ok", () => ({ Icon: CheckCircle2, iconClass: "text-green-600" }))
		.with("warn", () => ({ Icon: AlertCircle, iconClass: "text-amber-600" }))
		.exhaustive();
	const subParts: string[] = [plural(summary.alignedTurns, "aligned turn")];
	if (summary.turnsWithToolDivergence > 0) {
		subParts.push(`${summary.turnsWithToolDivergence} with tool divergence`);
	}
	if (summary.latencyRegressions > 0) {
		subParts.push(plural(summary.latencyRegressions, "latency regression"));
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Icon className={`size-4 ${iconClass}`} />
					{sentence.text}
				</CardTitle>
				<CardDescription>{subParts.join(" • ")}</CardDescription>
			</CardHeader>
		</Card>
	);
}

interface DiffCellProps {
	turn: ConversationTurn | undefined;
	annotatedTools: AnnotatedToolCall[];
	divergence: TurnDivergence;
	side: "source" | "target";
}

function DiffCell({ turn, annotatedTools, divergence, side }: DiffCellProps) {
	if (turn === undefined) {
		return (
			<Card className="border-dashed text-muted-foreground">
				<CardHeader>
					<CardDescription className="italic">No turn at this position</CardDescription>
				</CardHeader>
			</Card>
		);
	}
	const cardDivergent =
		divergence.toolsDiverge || divergence.latencyRegressed || divergence.shapeDiverged;
	const latencyBadgeVariant: "destructive" | "outline" =
		side === "target" && divergence.latencyRegressed ? "destructive" : "outline";
	return (
		<Card className={cardDivergent ? "border-amber-500/50" : undefined}>
			<CardHeader>
				<CardDescription className="flex flex-wrap items-center gap-2">
					<Badge variant={turn.role === "agent" ? "default" : "secondary"}>{turn.role}</Badge>
					{turn.responseLatencyMs !== null && (
						<Badge variant={latencyBadgeVariant}>
							<Zap />
							{turn.responseLatencyMs}ms
						</Badge>
					)}
					{turn.interrupted === true && (
						<Badge variant="destructive">
							<ZapOff />
							interrupted
						</Badge>
					)}
					{divergence.shapeDiverged && <Badge variant="destructive">shape changed</Badge>}
					{divergence.toolsDiverge && (
						<Badge variant="outline" className="border-amber-500/50 text-amber-600">
							tools {side === "source" ? "→" : "←"} differ
						</Badge>
					)}
				</CardDescription>
				<CardTitle className="text-base font-medium whitespace-pre-wrap break-words">
					{turn.text}
				</CardTitle>
			</CardHeader>
			{annotatedTools.length > 0 && (
				<CardContent>
					<ul className="space-y-1 text-xs">
						{annotatedTools.map((a) => (
							<li key={a.call.idx} className={`font-mono ${toolCallClass(a.status)}`}>
								{a.call.name}({JSON.stringify(a.call.args)})
							</li>
						))}
					</ul>
				</CardContent>
			)}
		</Card>
	);
}

function toolCallClass(status: ToolCallStatus): string {
	return match(status)
		.with("matched", () => "")
		.with("args-differ", () => "text-amber-600")
		.with("only-this-side", () => "text-red-600")
		.exhaustive();
}

function DiffLoading() {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Loader2 className="size-4 animate-spin" />
					Loading replay diff…
				</CardTitle>
			</CardHeader>
		</Card>
	);
}

function DiffError({ error }: { error: Error }) {
	return (
		<Card role="alert">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<AlertCircle className="size-4 text-destructive" />
					Failed to load diff.
				</CardTitle>
				<CardDescription className="break-all">{error.message}</CardDescription>
			</CardHeader>
		</Card>
	);
}
