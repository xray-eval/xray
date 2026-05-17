import type {
	Conversation,
	ConversationToolCall,
	ConversationTurn,
} from "@/server/sessions/sessions.types.ts";

import type {
	AlignedPair,
	AnnotatedToolCall,
	DiffSummary,
	PairWithDivergence,
	SummarySentence,
	TurnDivergence,
} from "./types.ts";

// Text wording is shown but NEVER counts as a divergence — LLM-generated text
// varies on every run, so flagging it would flood the diff with noise the
// target audience (voice-agent loop devs) doesn't care about.

// Both gates required: 1→3ms is noise; 50ms is noise on a 500ms turn but a
// real regression on a 100ms one.
const LATENCY_REGRESSION_MULTIPLIER = 2;
const LATENCY_REGRESSION_MIN_MS = 100;

export function alignTurns(source: ConversationTurn[], target: ConversationTurn[]): AlignedPair[] {
	const sourceByIdx = new Map(source.map((t) => [t.idx, t]));
	const targetByIdx = new Map(target.map((t) => [t.idx, t]));
	const indices = new Set<number>([...sourceByIdx.keys(), ...targetByIdx.keys()]);
	return [...indices]
		.sort((a, b) => a - b)
		.map((idx) => ({ idx, source: sourceByIdx.get(idx), target: targetByIdx.get(idx) }));
}

/**
 * Two greedy passes: exact (name + args via key-sorted serialize) → "matched";
 * same name, different args → "args-differ"; leftovers → "only-this-side".
 */
export function compareToolCalls(
	source: readonly ConversationToolCall[],
	target: readonly ConversationToolCall[],
): { sourceAnnotated: AnnotatedToolCall[]; targetAnnotated: AnnotatedToolCall[] } {
	const sourceAnnotated: AnnotatedToolCall[] = source.map((c) => ({
		call: c,
		status: "only-this-side",
	}));
	const targetAnnotated: AnnotatedToolCall[] = target.map((c) => ({
		call: c,
		status: "only-this-side",
	}));

	const argsKey = (c: ConversationToolCall): string => `${c.name}::${stableStringify(c.args)}`;

	for (const sa of sourceAnnotated) {
		if (sa.status !== "only-this-side") continue;
		const ta = targetAnnotated.find(
			(t) => t.status === "only-this-side" && argsKey(t.call) === argsKey(sa.call),
		);
		if (ta !== undefined) {
			sa.status = "matched";
			ta.status = "matched";
		}
	}
	for (const sa of sourceAnnotated) {
		if (sa.status !== "only-this-side") continue;
		const ta = targetAnnotated.find(
			(t) => t.status === "only-this-side" && t.call.name === sa.call.name,
		);
		if (ta !== undefined) {
			sa.status = "args-differ";
			ta.status = "args-differ";
		}
	}

	return { sourceAnnotated, targetAnnotated };
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const obj: Record<string, unknown> = { ...value };
	const entries = Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function diffTurn(
	source: ConversationTurn | undefined,
	target: ConversationTurn | undefined,
): TurnDivergence {
	const { sourceAnnotated, targetAnnotated } = compareToolCalls(
		source?.toolCalls ?? [],
		target?.toolCalls ?? [],
	);
	return {
		sourceToolCalls: sourceAnnotated,
		targetToolCalls: targetAnnotated,
		toolsDiverge:
			sourceAnnotated.some((c) => c.status !== "matched") ||
			targetAnnotated.some((c) => c.status !== "matched"),
		latencyRegressed: latencyRegressed(source, target),
		shapeDiverged: shapeDiverged(source, target),
	};
}

function latencyRegressed(
	source: ConversationTurn | undefined,
	target: ConversationTurn | undefined,
): boolean {
	if (source?.role !== "agent" || target?.role !== "agent") return false;
	const s = source.responseLatencyMs;
	const t = target.responseLatencyMs;
	if (s === null || t === null) return false;
	if (s === 0) return t >= LATENCY_REGRESSION_MIN_MS;
	return t >= s * LATENCY_REGRESSION_MULTIPLIER && t - s >= LATENCY_REGRESSION_MIN_MS;
}

function shapeDiverged(
	source: ConversationTurn | undefined,
	target: ConversationTurn | undefined,
): boolean {
	if (source === undefined || target === undefined) return false;
	if (source.role !== target.role) return true;
	if ((source.interrupted ?? null) !== (target.interrupted ?? null)) return true;
	return false;
}

/** Compute divergence for every aligned pair once, so the renderer can reuse it. */
export function divergencesFor(aligned: readonly AlignedPair[]): PairWithDivergence[] {
	return aligned.map((pair) => ({ pair, divergence: diffTurn(pair.source, pair.target) }));
}

export function summarize(
	divergences: readonly PairWithDivergence[],
	source: Conversation,
	target: Conversation,
): DiffSummary {
	let turnsWithToolDivergence = 0;
	let missingToolsInReplay = 0;
	let extraToolsInReplay = 0;
	let latencyRegressions = 0;
	let shapeDivergences = 0;
	for (const { divergence: d } of divergences) {
		if (d.toolsDiverge) turnsWithToolDivergence += 1;
		if (d.latencyRegressed) latencyRegressions += 1;
		if (d.shapeDiverged) shapeDivergences += 1;
		missingToolsInReplay += d.sourceToolCalls.filter((c) => c.status === "only-this-side").length;
		extraToolsInReplay += d.targetToolCalls.filter((c) => c.status === "only-this-side").length;
	}
	return {
		alignedTurns: divergences.length,
		sourceTurnCount: source.turns.length,
		targetTurnCount: target.turns.length,
		turnsWithToolDivergence,
		missingToolsInReplay,
		extraToolsInReplay,
		latencyRegressions,
		shapeDivergences,
	};
}

export function summarySentence(s: DiffSummary): SummarySentence {
	const parts: string[] = [];
	if (s.missingToolsInReplay > 0) {
		parts.push(`${plural(s.missingToolsInReplay, "tool call")} missing in replay`);
	}
	if (s.extraToolsInReplay > 0) {
		parts.push(`${plural(s.extraToolsInReplay, "extra tool call")} in replay`);
	}
	if (s.latencyRegressions > 0) {
		parts.push(plural(s.latencyRegressions, "latency regression"));
	}
	if (s.shapeDivergences > 0) {
		parts.push(plural(s.shapeDivergences, "shape change"));
	}
	const turnDelta = s.targetTurnCount - s.sourceTurnCount;
	if (turnDelta !== 0) {
		const word = turnDelta > 0 ? "extra turn" : "missing turn";
		parts.push(`${plural(Math.abs(turnDelta), word)} in replay`);
	}
	if (parts.length === 0) {
		return { tone: "ok", text: "Behavior matches (text varies, as expected)" };
	}
	return { tone: "warn", text: parts.join(", ") };
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}
