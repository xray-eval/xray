import { CheckIcon } from "lucide-react";
import { match } from "ts-pattern";

import { cn } from "@/client/lib/utils.ts";
import { ANALYSIS_STEPS } from "@/server/store/types.ts";

import type { ReplayDetailResponse } from "../../api/api.types.ts";

type StepState = "done" | "active" | "pending";

const STEP_LABELS: Record<(typeof ANALYSIS_STEPS)[number], string> = {
	vad: "Detecting turns",
	transcribe: "Transcribing",
	metrics: "Computing metrics",
	evaluate: "Evaluating",
};

function stepState(index: number, currentIndex: number): StepState {
	if (index < currentIndex) return "done";
	if (index === currentIndex) return "active";
	return "pending";
}

export function AnalysisProgress({ replay }: { replay: ReplayDetailResponse }) {
	if (replay.lifecycle_state !== "analyzing") return null;
	const current = replay.analysis_step;
	const currentIndex = current === null ? -1 : ANALYSIS_STEPS.indexOf(current);
	return (
		<div
			role="status"
			aria-label={`Analyzing replay${current === null ? "" : `: ${current}`}`}
			className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border/60 bg-card px-5 py-3.5"
		>
			<span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
				<span className="size-1.5 animate-pulse rounded-full bg-warning" />
				Analyzing
			</span>
			<ol className="flex flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
				{ANALYSIS_STEPS.map((step, i) => (
					<StepNode
						key={step}
						label={STEP_LABELS[step]}
						state={stepState(i, currentIndex)}
						showConnector={i > 0}
					/>
				))}
			</ol>
		</div>
	);
}

function StepNode({
	label,
	state,
	showConnector,
}: {
	label: string;
	state: StepState;
	showConnector: boolean;
}) {
	return (
		<li className="flex items-center gap-1.5">
			{showConnector && <span aria-hidden="true" className="h-px w-4 bg-border" />}
			<span
				aria-current={state === "active" ? "step" : undefined}
				className={cn(
					"flex items-center gap-1.5 font-mono text-[11px] tracking-tight",
					match(state)
						.with("done", () => "text-muted-foreground")
						.with("active", () => "text-foreground")
						.with("pending", () => "text-muted-foreground/45")
						.exhaustive(),
				)}
			>
				<StepDot state={state} />
				{label}
			</span>
		</li>
	);
}

function StepDot({ state }: { state: StepState }) {
	return match(state)
		.with("done", () => (
			<span className="flex size-3.5 items-center justify-center rounded-full bg-success/15 text-success">
				<CheckIcon className="size-2.5" aria-hidden="true" />
			</span>
		))
		.with("active", () => (
			<span className="size-3.5 rounded-full border-2 border-warning bg-warning/20" />
		))
		.with("pending", () => (
			<span className="size-3.5 rounded-full border border-border bg-transparent" />
		))
		.exhaustive();
}
