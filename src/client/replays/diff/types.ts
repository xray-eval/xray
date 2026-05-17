import type { ConversationToolCall, ConversationTurn } from "@/server/sessions/sessions.types.ts";

export interface AlignedPair {
	idx: number;
	source: ConversationTurn | undefined;
	target: ConversationTurn | undefined;
}

export type ToolCallStatus = "matched" | "args-differ" | "only-this-side";

export interface AnnotatedToolCall {
	call: ConversationToolCall;
	status: ToolCallStatus;
}

export interface TurnDivergence {
	sourceToolCalls: AnnotatedToolCall[];
	targetToolCalls: AnnotatedToolCall[];
	/** Any tool call on either side is not "matched". */
	toolsDiverge: boolean;
	/** Target slower than source past the threshold (agent turns only). */
	latencyRegressed: boolean;
	/** Both sides present but structurally different — role or interrupted-state changed. */
	shapeDiverged: boolean;
}

export interface PairWithDivergence {
	pair: AlignedPair;
	divergence: TurnDivergence;
}

export interface DiffSummary {
	alignedTurns: number;
	sourceTurnCount: number;
	targetTurnCount: number;
	turnsWithToolDivergence: number;
	missingToolsInReplay: number;
	extraToolsInReplay: number;
	latencyRegressions: number;
	shapeDivergences: number;
}

export type SummaryTone = "ok" | "warn";

export interface SummarySentence {
	tone: SummaryTone;
	text: string;
}
