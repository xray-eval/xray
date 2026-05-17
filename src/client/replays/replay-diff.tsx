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
	const aligned = alignTurns(source.turns, target.turns);
	const diffCount = aligned.filter((p) => p.kind !== "same").length;
	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<CheckCircle2 className="size-4 text-green-600" />
						Replay complete
					</CardTitle>
					<CardDescription>
						{diffCount} of {aligned.length} aligned turns differ
					</CardDescription>
				</CardHeader>
			</Card>

			<div className="grid grid-cols-2 gap-3 text-xs font-medium text-muted-foreground">
				<div>Source</div>
				<div>Replay</div>
			</div>

			<ol className="space-y-3">
				{aligned.map((pair) => (
					<li key={pair.idx} className="grid grid-cols-2 gap-3">
						<DiffCell turn={pair.source} other={pair.target} side="source" />
						<DiffCell turn={pair.target} other={pair.source} side="target" />
					</li>
				))}
			</ol>
		</div>
	);
}

export interface AlignedPair {
	idx: number;
	source: ConversationTurn | undefined;
	target: ConversationTurn | undefined;
	kind: "same" | "diff" | "missing";
}

/**
 * Pair turns by idx so the same position in source and target line up. A
 * missing side becomes `undefined`. "diff" means both sides exist but at
 * least one tracked field differs.
 */
export function alignTurns(source: ConversationTurn[], target: ConversationTurn[]): AlignedPair[] {
	const sourceByIdx = new Map(source.map((t) => [t.idx, t]));
	const targetByIdx = new Map(target.map((t) => [t.idx, t]));
	const indices = new Set<number>([...sourceByIdx.keys(), ...targetByIdx.keys()]);
	return [...indices]
		.sort((a, b) => a - b)
		.map((idx) => {
			const s = sourceByIdx.get(idx);
			const t = targetByIdx.get(idx);
			const kind: AlignedPair["kind"] =
				s === undefined || t === undefined ? "missing" : turnsDiffer(s, t) ? "diff" : "same";
			return { idx, source: s, target: t, kind };
		});
}

/**
 * Best-effort field-by-field comparison. `JSON.stringify` on `args` is order-
 * sensitive — two semantically-equal objects with different key orders read
 * as different. Acceptable for v1: surfaces in the diff view, but the user
 * can visually verify. Upgrade to a stable deep-equal when this matters.
 *
 * `responseLatencyMs` is deliberately NOT compared: replay latency is wall-
 * clock from the webhook; source latency is the original measurement. They
 * differ on essentially every agent turn, so including it would flood the
 * diff with false positives. The cards still render the per-side value for
 * context.
 */
export function turnsDiffer(a: ConversationTurn, b: ConversationTurn): boolean {
	if (a.role !== b.role) return true;
	if (a.text !== b.text) return true;
	if ((a.interrupted ?? null) !== (b.interrupted ?? null)) return true;
	if (a.toolCalls.length !== b.toolCalls.length) return true;
	for (let i = 0; i < a.toolCalls.length; i++) {
		const ac = a.toolCalls[i];
		const bc = b.toolCalls[i];
		if (!ac || !bc) return true;
		if (ac.name !== bc.name) return true;
		if (JSON.stringify(ac.args) !== JSON.stringify(bc.args)) return true;
	}
	return false;
}

interface DiffCellProps {
	turn: ConversationTurn | undefined;
	other: ConversationTurn | undefined;
	side: "source" | "target";
}

function DiffCell({ turn, other, side }: DiffCellProps) {
	if (turn === undefined) {
		return (
			<Card className="border-dashed text-muted-foreground">
				<CardHeader>
					<CardDescription className="italic">No turn at this position</CardDescription>
				</CardHeader>
			</Card>
		);
	}
	const differs = other !== undefined && turnsDiffer(turn, other);
	const textDiffers = other !== undefined && turn.text !== other.text;
	return (
		<Card className={differs ? "border-amber-500/50" : undefined}>
			<CardHeader>
				<CardDescription className="flex flex-wrap items-center gap-2">
					<Badge variant={turn.role === "agent" ? "default" : "secondary"}>{turn.role}</Badge>
					{turn.responseLatencyMs !== null && (
						<Badge variant="outline">
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
					{differs && (
						<Badge variant="outline" className="border-amber-500/50 text-amber-600">
							{side === "source" ? "changed →" : "← changed"}
						</Badge>
					)}
				</CardDescription>
				<CardTitle
					className={`text-base font-medium whitespace-pre-wrap break-words ${
						textDiffers ? "underline decoration-amber-500/50 decoration-2 underline-offset-2" : ""
					}`}
				>
					{turn.text}
				</CardTitle>
			</CardHeader>
			{turn.toolCalls.length > 0 && (
				<CardContent>
					<ul className="space-y-1 text-xs">
						{turn.toolCalls.map((call) => (
							<li key={call.idx} className="font-mono">
								{call.name}({JSON.stringify(call.args)})
							</li>
						))}
					</ul>
				</CardContent>
			)}
		</Card>
	);
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
