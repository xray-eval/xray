import type { TurnWindow } from "@/server/replays/timeline.ts";
import { rowsInTurnWindow } from "@/server/replays/timeline.ts";
import type {
	ModelUsageRow,
	ReplayMetricRow,
	ReplayTurnRow,
	ToolCallRow,
	TurnRole,
	TurnTranscriptRow,
} from "@/server/store/types.ts";

/**
 * Per-field cap on a tool call's `args_json` / `result_json`. A judge decides
 * whether the agent looked something up from the head of a payload, never from
 * page 40 of a RAG dump.
 */
export const MAX_EVIDENCE_FIELD_CHARS = 1024;

/**
 * Cap on an identifier — a tool name or a model id. Much tighter than the
 * payload cap because a real identifier is a handful of characters, while both
 * arrive from uncapped OTLP attributes (`gen_ai.tool.name`,
 * `gen_ai.request.model`) that a buggy or hostile exporter can make arbitrarily
 * long. Keeping identifiers small is what makes the per-turn worst case a small
 * fraction of the total budget.
 */
export const MAX_EVIDENCE_IDENT_CHARS = 256;

/** Per-turn cap on tool rows and on model rows, counted separately. */
export const MAX_EVIDENCE_ROWS_PER_TURN = 6;

/**
 * Cap on the whole evidence section, ~8k tokens.
 *
 * Load-bearing, not belt-and-braces: without it a 40-turn replay of worst-case
 * rows renders hundreds of KB, a hard request failure on the 128k-context judge
 * providers (OpenAI, Mistral) that would map every judge on that replay to
 * `errored`. Per-field and per-turn caps bound one turn, not their sum.
 *
 * Invariant the caps must preserve: **one turn rendered at its per-turn worst
 * case must stay comfortably under this total.** If it can reach the total, the
 * first evidence-bearing turn is refused and the feature silently emits nothing.
 * At the current caps a turn maxed out on all six tool rows AND all six model
 * rows, every field past its cap, renders ~16.6k chars — about half the budget,
 * so it renders rather than being refused, and (with no exhaustion latch) later
 * turns still get the rest. A realistically-heavy turn is an order of magnitude
 * smaller. The "renders a turn that is maximal under the per-turn caps" test
 * pins the invariant.
 */
export const MAX_EVIDENCE_TOTAL_CHARS = 32_768;

export interface JudgeEvidenceMetrics {
	readonly agentResponseMs: number | null;
	readonly interrupted: boolean;
	readonly yieldMs: number | null;
}

export interface JudgeEvidenceTurn {
	readonly turnIdx: number;
	readonly role: TurnRole;
	/** null when the transcription stage produced no row for this turn. */
	readonly text: string | null;
	readonly toolCalls: readonly ToolCallRow[];
	readonly modelUsage: readonly ModelUsageRow[];
	/** null when `calculate-metrics` produced no row for this turn. */
	readonly metrics: JudgeEvidenceMetrics | null;
}

export interface JudgeEvidence {
	readonly hasRecordingAnchor: boolean;
	readonly turns: readonly JudgeEvidenceTurn[];
}

export interface BuildJudgeEvidenceArgs {
	readonly turnRows: readonly ReplayTurnRow[];
	readonly transcripts: readonly TurnTranscriptRow[];
	readonly metricRows: readonly ReplayMetricRow[];
	readonly toolRows: readonly ToolCallRow[];
	readonly usageRows: readonly ModelUsageRow[];
	readonly windowByIdx: ReadonlyMap<number, TurnWindow>;
	readonly recordingStartedAt: string | null;
}

/**
 * Project the rows the analyze chain produced into what a judge is shown.
 *
 * Walks `replay_turns` — the authoritative turn list — rather than
 * `turn_transcripts`, so a turn whose transcription failed is still visible to
 * the judge as `(no transcript)` instead of silently vanishing from the
 * conversation it is scoring.
 *
 * Tool/model membership is the same tiling-window attribution the assertion
 * evaluator uses (`rowsInTurnWindow`), so a judge and an assertion can never
 * disagree about which turn a call belongs to. With no `recording_started_at`
 * no row can be placed at all; the caller renders that as an explicit note.
 */
export function buildJudgeEvidence(args: BuildJudgeEvidenceArgs): JudgeEvidence {
	const { turnRows, transcripts, metricRows, toolRows, usageRows, windowByIdx } = args;
	const recordingStartedAt = args.recordingStartedAt;
	const textByIdx = new Map(transcripts.map((t) => [t.turnIdx, t.text]));
	const metricByIdx = new Map(metricRows.map((m) => [m.turnIdx, m]));

	const turns = turnRows.map((row): JudgeEvidenceTurn => {
		const window = windowByIdx.get(row.idx);
		const metric = metricByIdx.get(row.idx);
		return {
			turnIdx: row.idx,
			role: row.role,
			text: textByIdx.get(row.idx) ?? null,
			toolCalls:
				window === undefined
					? []
					: chronological(rowsInTurnWindow(toolRows, window, recordingStartedAt)),
			modelUsage:
				window === undefined
					? []
					: chronological(rowsInTurnWindow(usageRows, window, recordingStartedAt)),
			metrics:
				metric === undefined
					? null
					: {
							agentResponseMs: metric.agentResponseMs,
							interrupted: metric.interrupted,
							yieldMs: metric.yieldMs,
						},
		};
	});

	return { hasRecordingAnchor: recordingStartedAt !== null, turns };
}

/**
 * Sort in-window rows by wall-clock start.
 *
 * The processor selects `tool_calls` / `model_usage` with no ORDER BY, so the
 * rows arrive in insertion order — and OTLP spans are batched and re-exported,
 * so insertion order is not wall-clock order. References the judge is asked to
 * score are frequently order-sensitive ("looks up the balance BEFORE quoting
 * it"), and the per-turn cap slices off the tail, so an unsorted list can both
 * mis-order the calls and drop the earliest ones.
 *
 * Compares parsed epoch ms rather than the raw strings. Today the only writer of
 * these columns normalizes through `toISOString()` (`otlp.service.ts`), so a
 * lexicographic compare would happen to agree — but that couples this sort to a
 * detail of the ingest path, and it's the same numeric comparison
 * `audioOffsetMs` already does for the very same columns. An unparseable
 * timestamp sorts last instead of scrambling the order around it;
 * `rowsInTurnWindow` has already dropped such rows, so this is belt-and-braces.
 */
function chronological<T extends { readonly startedAt: string | null }>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => epochMs(a.startedAt) - epochMs(b.startedAt));
}

function epochMs(iso: string | null): number {
	if (iso === null) return Number.POSITIVE_INFINITY;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

const NO_ANCHOR_NOTE =
	"(note: tool and model evidence is unavailable for this replay — no recording anchor to place calls on the timeline)";

const BUDGET_EXHAUSTED_LINE = "  [evidence omitted: evidence budget exhausted]";

/**
 * Render the transcript, each turn followed by its indented evidence lines.
 *
 * Owns every cap and the newline sanitization, so no caller can assemble an
 * unbounded or line-spoofable prompt. Turns render in `turnIdx` order. A turn
 * whose evidence block would push the running total past
 * `MAX_EVIDENCE_TOTAL_CHARS` keeps its transcript line but has its block
 * replaced whole by a marker; later turns are still tried against the remaining
 * budget, so one heavy turn costs only itself.
 */
export function renderTranscriptWithEvidence(evidence: JudgeEvidence): string {
	if (evidence.turns.length === 0) return "(empty)";

	const sorted = [...evidence.turns].sort((a, b) => a.turnIdx - b.turnIdx);
	const lines: string[] = [];
	if (!evidence.hasRecordingAnchor) lines.push(NO_ANCHOR_NOTE);

	let spent = 0;
	for (const turn of sorted) {
		lines.push(`[turn ${turn.turnIdx}] [${turn.role}]: ${transcriptLine(turn.text)}`);
		const block = renderEvidenceBlock(turn, evidence.hasRecordingAnchor);
		if (block.length === 0) continue;
		const cost = block.reduce((sum, line) => sum + line.length + 1, 0);
		// Skip only the turns that don't fit, rather than latching a
		// budget-exhausted flag: one heavy turn must not starve every later
		// turn's small block. Blocks stay atomic (a turn's evidence is rendered
		// whole or replaced whole), so the output is still deterministic, and the
		// marker tells the judge evidence was withheld rather than absent.
		if (spent + cost > MAX_EVIDENCE_TOTAL_CHARS) {
			lines.push(BUDGET_EXHAUSTED_LINE);
			continue;
		}
		spent += cost;
		lines.push(...block);
	}
	return lines.join("\n");
}

/**
 * The turn's speech, or the marker that stands in for it.
 *
 * Whitespace-only text collapses to the same marker as a missing
 * `turn_transcripts` row, because to a judge they are one fact: the turn
 * happened and no words are available for it. The transcription stage writes the
 * provider's `text` unguarded, so a VAD turn that carried only background noise
 * persists as an empty string — rendered verbatim that leaves a bare
 * `[turn N] [role]: `, a third state the judge cannot tell apart from a
 * formatting bug.
 *
 * Escaped but never truncated: the transcript is what SYSTEM_PROMPT calls
 * authoritative for "what was said", and it carried no cap before evidence
 * existed. The evidence budget bounds evidence, not speech.
 */
function transcriptLine(text: string | null): string {
	if (text === null || text.trim().length === 0) return "(no transcript)";
	return escapeLineBreaks(text);
}

function renderEvidenceBlock(turn: JudgeEvidenceTurn, hasRecordingAnchor: boolean): string[] {
	const lines: string[] = [];
	// Without an anchor the projection already dropped every tool/model row;
	// guarding here too keeps the intent legible at the render site.
	if (hasRecordingAnchor) {
		lines.push(...renderToolLines(turn.toolCalls));
		lines.push(...renderModelLines(turn.modelUsage));
	}
	const metricsLine = renderMetricsLine(turn.metrics);
	if (metricsLine !== null) lines.push(metricsLine);
	return lines;
}

function renderToolLines(rows: readonly ToolCallRow[]): string[] {
	const lines: string[] = [];
	const shown = rows.slice(0, MAX_EVIDENCE_ROWS_PER_TURN);
	for (const row of shown) {
		const latency = row.latencyMs === null ? "" : ` latency=${row.latencyMs}ms`;
		lines.push(`  [tool] ${sanitizeValue(row.name, MAX_EVIDENCE_IDENT_CHARS)}${latency}`);
		if (row.argsJson !== null) lines.push(`    args: ${sanitizeValue(row.argsJson)}`);
		if (row.resultJson !== null) lines.push(`    result: ${sanitizeValue(row.resultJson)}`);
	}
	const omitted = rows.length - shown.length;
	if (omitted > 0) lines.push(`  [tool] +${omitted} more tool calls omitted`);
	return lines;
}

function renderModelLines(rows: readonly ModelUsageRow[]): string[] {
	const lines: string[] = [];
	// A row carrying neither a model id nor a TTFT tells the judge nothing;
	// filter before the cap so such rows can't consume a slot.
	const informative = rows.filter((r) => r.model !== null || r.ttftMs !== null);
	const shown = informative.slice(0, MAX_EVIDENCE_ROWS_PER_TURN);
	for (const row of shown) {
		const ttft = row.ttftMs === null ? "" : ` ttft=${row.ttftMs}ms`;
		const model =
			row.model === null ? "(unknown model)" : sanitizeValue(row.model, MAX_EVIDENCE_IDENT_CHARS);
		lines.push(`  [model] ${model}${ttft}`);
	}
	const omitted = informative.length - shown.length;
	if (omitted > 0) lines.push(`  [model] +${omitted} more model calls omitted`);
	return lines;
}

function renderMetricsLine(metrics: JudgeEvidenceMetrics | null): string | null {
	if (metrics === null) return null;
	const parts: string[] = [];
	if (metrics.agentResponseMs !== null) parts.push(`response=${metrics.agentResponseMs}ms`);
	if (metrics.interrupted) {
		parts.push("interrupted=yes");
		if (metrics.yieldMs !== null) parts.push(`yielded_after=${metrics.yieldMs}ms`);
	}
	if (parts.length === 0) return null;
	return `  [metrics] ${parts.join(" ")}`;
}

/**
 * Collapse every line break to the two-character escape.
 *
 * Applied to EVERY interpolated string in the prompt — transcript text, tool
 * name, model id, args and result — because the format's only structural
 * invariant is "one line per turn, evidence lines are indented", and a raw
 * newline in any of them breaks it. The spoofing risk is concrete: a tool
 * `result` is often a third-party API response, and `tool_calls.name` /
 * `model_usage.model` come from uncapped OTLP span attributes
 * (`gen_ai.tool.name`, `gen_ai.request.model`) that the receiver neither
 * length-limits nor sanitizes. Any of them could otherwise emit what reads as a
 * fresh `[turn N] [agent]: …` line and fabricate agent behavior. Transcript text
 * is included because STT providers legitimately return multi-line text.
 *
 * Escaping is deliberately separate from truncation: transcript text must be
 * escaped but never clipped — SYSTEM_PROMPT calls it authoritative for what was
 * said, and it carried no cap before evidence existed — while evidence values
 * get both.
 */
function escapeLineBreaks(raw: string): string {
	// Everything past \n / \r is a mandatory line break in Unicode's own terms
	// (UAX #14 class BK) and a line terminator to plenty of parsers and
	// tokenizers, so all of them are the same spoofing vector and get the same
	// treatment. \v and \f are only reachable through an identifier: args and
	// result are `JSON.stringify`-ed at ingest (`safeJsonString`), which escapes
	// every C0 char, while `tool_calls.name` / `model_usage.model` are stored
	// verbatim from the span attribute.
	return raw.replace(/\r\n|[\n\r\v\f\u2028\u2029\u0085]/g, "\\n");
}

/**
 * Escape, then cap an evidence value, marking how much was withheld.
 *
 * Order matters: escape first, so the cap is measured against — and applies to —
 * the string that actually reaches the model. A cut that lands inside a `\n`
 * escape leaves a harmless trailing backslash; it cannot re-create a newline.
 *
 * `cap` defaults to the payload cap; identifiers pass the much tighter
 * `MAX_EVIDENCE_IDENT_CHARS`.
 */
function sanitizeValue(raw: string, cap: number = MAX_EVIDENCE_FIELD_CHARS): string {
	const flat = escapeLineBreaks(raw);
	if (flat.length <= cap) return flat;
	return `${flat.slice(0, cap)}… [truncated ${cap} of ${flat.length} chars]`;
}
