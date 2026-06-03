import { skipToken, useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, MinusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { match } from "ts-pattern";

import { Card } from "@/client/components/ui/card.tsx";
import { Skeleton } from "@/client/components/ui/skeleton.tsx";
import { cn } from "@/client/lib/utils.ts";

import { getReplayResult } from "../../api/api.ts";
import type {
	AssertionOutcomeResponse,
	JudgeOutcomeResponse,
	ReplayDetailResponse,
	ReplayResult,
} from "../../api/api.types.ts";
import type {
	AssertionTurnGroup,
	EvaluationStatus,
	OutcomeTally,
	VerdictTone,
} from "./evaluation-model.ts";
import { groupAssertionsByTurn, tallyOutcomes, verdictTone } from "./evaluation-model.ts";

export function EvaluationPanel({
	replayId,
	lifecycleState,
}: {
	replayId: string;
	lifecycleState: ReplayDetailResponse["lifecycle_state"];
}) {
	// The server answers 409 until evaluation has run, so gate the fetch on the
	// completed lifecycle rather than letting it fail. `skipToken` keeps the
	// hook unconditional while contributing no network call.
	const enabled = lifecycleState === "completed";
	const query = useQuery({
		queryKey: ["replays", { id: replayId }, "result"],
		queryFn: enabled ? ({ signal }) => getReplayResult(replayId, signal) : skipToken,
	});
	if (!enabled) return null;
	return match(query)
		.with({ status: "pending" }, () => (
			<Card className="gap-0 overflow-hidden p-0" aria-busy="true">
				<div className="px-6 py-5">
					<Skeleton className="h-16 w-full" />
				</div>
			</Card>
		))
		.with({ status: "error" }, () => (
			<Card className="gap-0 overflow-hidden p-0">
				<p className="px-6 py-5 text-sm text-muted-foreground">Evaluation result is unavailable.</p>
			</Card>
		))
		.with({ status: "success" }, (q) => <EvaluationCard result={q.data} />)
		.exhaustive();
}

function EvaluationCard({ result }: { result: ReplayResult }) {
	const tone = verdictTone(result);
	const assertionTally = tallyOutcomes(result.assertions);
	const judgeTally = tallyOutcomes(result.judges);
	const groups = groupAssertionsByTurn(result.assertions);
	const segments: OutcomeSegment[] = [
		...result.assertions.map((a) => ({
			key: `a-${a.turn_idx}-${a.assertion_idx}`,
			status: a.status,
			name: a.kind,
			label: `turn ${a.turn_idx} · ${a.kind} · ${a.status}`,
		})),
		...result.judges.map((j) => ({
			key: `j-${j.judge_idx}`,
			status: j.status,
			name: j.kind,
			label: `judge · ${j.kind} · ${j.status}`,
		})),
	];
	const hasJudges = result.judges.length > 0;
	const hasDetails = result.assertions.length > 0 || hasJudges;
	// Collapse the per-check breakdown when everything passed — a green run
	// doesn't need scrutiny; a failure does, so non-passing verdicts expand by
	// default.
	const [expanded, setExpanded] = useState(tone !== "passed");
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<section aria-label="Evaluation result">
				<VerdictHero
					tone={tone}
					assertions={assertionTally}
					judges={judgeTally}
					segments={segments}
					expandable={hasDetails}
					expanded={expanded}
					onToggle={() => setExpanded((prev) => !prev)}
				/>
				{!hasDetails && (
					<p className="px-5 py-4 text-xs text-muted-foreground">
						No assertions or judges declared for this conversation.
					</p>
				)}
				{hasDetails && expanded && (
					<div
						className={cn(
							"grid divide-y divide-border/50",
							hasJudges && "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:divide-x lg:divide-y-0",
						)}
					>
						<AssertionsSection groups={groups} tally={assertionTally} />
						{hasJudges && <JudgesSection judges={result.judges} tally={judgeTally} />}
					</div>
				)}
			</section>
		</Card>
	);
}

interface OutcomeSegment {
	key: string;
	status: EvaluationStatus;
	name: string;
	label: string;
}

function VerdictHero({
	tone,
	assertions,
	judges,
	segments,
	expandable,
	expanded,
	onToggle,
}: {
	tone: VerdictTone;
	assertions: OutcomeTally;
	judges: OutcomeTally;
	segments: OutcomeSegment[];
	expandable: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	const chrome = verdictChrome(tone);
	return (
		<div className={cn("relative space-y-4 border-b border-border/60 px-6 py-5", chrome.wrap)}>
			<span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", chrome.bar)} />
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
				<div className="flex items-center gap-3.5">
					<span className={cn("flex size-9 items-center justify-center rounded-full", chrome.chip)}>
						<VerdictGlyph tone={tone} className="size-5" />
					</span>
					<div className="space-y-0.5">
						<p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
							Evaluation
						</p>
						<p className={cn("text-2xl font-semibold leading-none tracking-tight", chrome.text)}>
							{chrome.label}
						</p>
					</div>
				</div>
				<div className="flex items-center gap-5">
					{assertions.total > 0 && <TallyStat label="assertions" tally={assertions} />}
					{judges.total > 0 && <TallyStat label="judges" tally={judges} />}
					{expandable && (
						<button
							type="button"
							onClick={onToggle}
							aria-expanded={expanded}
							className="flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
						>
							{expanded ? "Hide" : "Details"}
							<ChevronDownIcon
								aria-hidden="true"
								className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
							/>
						</button>
					)}
				</div>
			</div>
			{segments.length > 0 && <OutcomeBar segments={segments} />}
		</div>
	);
}

function TallyStat({ label, tally }: { label: string; tally: OutcomeTally }) {
	const allPassed = tally.passed === tally.total;
	return (
		<div className="text-right">
			<p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
				{label}
			</p>
			<p className="font-mono text-lg font-semibold tabular-nums leading-tight">
				<span className={allPassed ? "text-success" : "text-foreground"}>{tally.passed}</span>
				<span className="text-muted-foreground/50">/{tally.total}</span>
			</p>
		</div>
	);
}

// One cell per declared check (assertion or judge), color-coded by outcome.
// Labeled + legended so it reads as "here are your N checks, this many passed"
// — not as a sequence of steps.
function OutcomeBar({ segments }: { segments: OutcomeSegment[] }) {
	const tally = tallyOutcomes(segments);
	const counts: { status: EvaluationStatus; count: number }[] = [
		{ status: "passed", count: tally.passed },
		{ status: "failed", count: tally.failed },
		{ status: "errored", count: tally.errored },
	];
	const legend = counts.filter((item) => item.count > 0);
	// Name each cell with its check kind when few enough to stay legible; past
	// that the cells stay bare and the kind lives in the hover label + Details.
	const showNames = segments.length <= 16;
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
				<span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
					Checks · {segments.length}
				</span>
				<div className="flex items-center gap-3">
					{legend.map((item) => (
						<span
							key={item.status}
							className="flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-muted-foreground"
						>
							<span className={cn("size-2 rounded-[2px]", statusBarClass(item.status))} />
							{item.count} {statusLabel(item.status)}
						</span>
					))}
				</div>
			</div>
			<div className="flex w-full gap-1" aria-hidden="true">
				{segments.map((s) => (
					<div key={s.key} title={s.label} className="flex min-w-0 flex-1 flex-col gap-1">
						<span className={cn("h-2.5 rounded-[3px]", statusBarClass(s.status))} />
						{showNames && (
							<span className="truncate text-center font-mono text-[10px] leading-tight text-muted-foreground/70">
								{s.name}
							</span>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

function statusLabel(status: EvaluationStatus): string {
	return match(status)
		.with("passed", () => "passed")
		.with("failed", () => "failed")
		.with("errored", () => "errored")
		.exhaustive();
}

function AssertionsSection({
	groups,
	tally,
}: {
	groups: AssertionTurnGroup[];
	tally: OutcomeTally;
}) {
	if (groups.length === 0) {
		return (
			<section className="px-5 py-4">
				<SectionLabel label="Assertions" />
				<p className="text-xs text-muted-foreground">
					No assertions declared for this conversation.
				</p>
			</section>
		);
	}
	return (
		<section className="px-5 py-4">
			<SectionLabel label="Assertions" meta={`${tally.passed}/${tally.total} passed`} />
			<div className="space-y-3.5">
				{groups.map((group) => (
					<div key={group.turnIdx} className="space-y-1.5">
						<p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/55">
							Turn {group.turnIdx}
						</p>
						<ul className="space-y-1.5">
							{group.outcomes.map((outcome) => (
								<AssertionRow
									key={`${outcome.turn_idx}-${outcome.assertion_idx}`}
									outcome={outcome}
								/>
							))}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}

function AssertionRow({ outcome }: { outcome: AssertionOutcomeResponse }) {
	return (
		<li className="flex items-start gap-2.5 font-mono text-xs">
			<StatusGlyph status={outcome.status} className="mt-px" />
			<div className="min-w-0 flex-1">
				<span className="text-foreground">{outcome.kind}</span>
				{outcome.message !== null && (
					<p
						className={cn(
							"mt-0.5 break-words text-[11px] leading-relaxed",
							outcome.status === "passed" ? "text-muted-foreground" : "text-destructive/90",
						)}
					>
						{outcome.message}
					</p>
				)}
			</div>
		</li>
	);
}

function JudgesSection({ judges, tally }: { judges: JudgeOutcomeResponse[]; tally: OutcomeTally }) {
	if (judges.length === 0) return null;
	return (
		<section className="px-5 py-4">
			<SectionLabel label="Judges" meta={`${tally.passed}/${tally.total} passed`} />
			<ul className="space-y-3.5">
				{judges.map((judge) => (
					<JudgeRow key={judge.judge_idx} judge={judge} />
				))}
			</ul>
		</section>
	);
}

function JudgeRow({ judge }: { judge: JudgeOutcomeResponse }) {
	return (
		<li className="space-y-1.5">
			<div className="flex items-center justify-between gap-3 font-mono text-xs">
				<span className="flex items-center gap-2">
					<StatusGlyph status={judge.status} />
					<span className="text-foreground">{judge.kind}</span>
				</span>
				{judge.score !== null && (
					<span className="shrink-0 tabular-nums text-muted-foreground">
						{judge.score}
						<span className="text-muted-foreground/50">/100</span>
					</span>
				)}
			</div>
			{judge.score !== null && <ScoreMeter score={judge.score} status={judge.status} />}
			{judge.reason !== null && (
				<p className="text-[11px] leading-relaxed text-muted-foreground">{judge.reason}</p>
			)}
		</li>
	);
}

function ScoreMeter({ score, status }: { score: number; status: EvaluationStatus }) {
	const pct = Math.max(0, Math.min(100, score));
	return (
		<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
			<div
				className={cn("h-full rounded-full", statusBarClass(status))}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

function SectionLabel({ label, meta }: { label: string; meta?: string }) {
	return (
		<div className="mb-3 flex items-baseline justify-between gap-3">
			<h3 className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-foreground/70">
				{label}
			</h3>
			{meta !== undefined && (
				<span className="font-mono text-[10px] tracking-wide tabular-nums text-muted-foreground/70">
					{meta}
				</span>
			)}
		</div>
	);
}

function StatusGlyph({ status, className }: { status: EvaluationStatus; className?: string }) {
	return match(status)
		.with("passed", () => (
			<CheckIcon aria-label="passed" className={cn("size-3.5 shrink-0 text-success", className)} />
		))
		.with("failed", () => (
			<XIcon aria-label="failed" className={cn("size-3.5 shrink-0 text-destructive", className)} />
		))
		.with("errored", () => (
			<TriangleAlertIcon
				aria-label="errored"
				className={cn("size-3.5 shrink-0 text-warning", className)}
			/>
		))
		.exhaustive();
}

function VerdictGlyph({ tone, className }: { tone: VerdictTone; className?: string }) {
	return match(tone)
		.with("passed", () => <CheckIcon aria-hidden="true" className={className} />)
		.with("failed", () => <XIcon aria-hidden="true" className={className} />)
		.with("empty", () => <MinusIcon aria-hidden="true" className={className} />)
		.exhaustive();
}

function statusBarClass(status: EvaluationStatus): string {
	return match(status)
		.with("passed", () => "bg-success")
		.with("failed", () => "bg-destructive")
		.with("errored", () => "bg-warning")
		.exhaustive();
}

interface VerdictChrome {
	wrap: string;
	bar: string;
	chip: string;
	text: string;
	label: string;
}

function verdictChrome(tone: VerdictTone): VerdictChrome {
	return match(tone)
		.with("passed", () => ({
			wrap: "bg-success/[0.06]",
			bar: "bg-success",
			chip: "bg-success/15 text-success",
			text: "text-success",
			label: "Passed",
		}))
		.with("failed", () => ({
			wrap: "bg-destructive/[0.06]",
			bar: "bg-destructive",
			chip: "bg-destructive/15 text-destructive",
			text: "text-destructive",
			label: "Failed",
		}))
		.with("empty", () => ({
			wrap: "",
			bar: "bg-border",
			chip: "bg-muted text-muted-foreground",
			text: "text-foreground",
			label: "No verdict",
		}))
		.exhaustive();
}
