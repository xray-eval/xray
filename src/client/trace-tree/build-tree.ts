import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";

import { attributeSpansToTurns, spanStartSeconds } from "./attribution.ts";
import type { SpanRow, TraceScale, TreeRow, TurnRow, UntimedGroupRow } from "./trace-tree.types.ts";

/**
 * A span's start/end on the recording-t=0 axis (seconds). Start comes from the
 * server-derived `audio_offset_ms` (0 when the span can't be placed — a replay
 * with no anchor renders every span clustered at 0 rather than at a wrong
 * wall-clock origin); end is start + the span's own duration.
 */
function spanSeconds(span: SpanResponse): { startSec: number; endSec: number } {
	const startSec = spanStartSeconds(span) ?? 0;
	const durMs = Math.max(0, Date.parse(span.ended_at) - Date.parse(span.started_at));
	return { startSec, endSec: startSec + durMs / 1_000 };
}

export type TreeBuildResult = Readonly<{
	rows: readonly TreeRow[];
	scale: TraceScale;
}>;

/**
 * Build a flat list of tree rows from turns + spans. Roots are turns (in
 * `idx` order); each turn's attributed spans hang under it as a parent_span
 * tree. Orphans land under a single "Untimed" root at the end. Returned in
 * pre-order so a flat render maps row-index → screen-y in one pass.
 *
 * Time scale spans the union of all turn ranges + span ranges, so the bars
 * always sit inside the visible axis.
 */
export function buildTree(
	turns: readonly ReplayTurnResponse[],
	spans: readonly SpanResponse[],
): TreeBuildResult {
	const { perTurn, untimed } = attributeSpansToTurns(turns, spans);
	const rows: TreeRow[] = [];

	let minSec = Number.POSITIVE_INFINITY;
	let maxSec = Number.NEGATIVE_INFINITY;
	const observe = (start: number, end: number) => {
		if (Number.isFinite(start) && start < minSec) minSec = start;
		if (Number.isFinite(end) && end > maxSec) maxSec = end;
	};

	for (const turn of turns) {
		const startedAtSec = turn.turn_start_ms / 1_000;
		const endedAtSec = turn.turn_end_ms / 1_000;
		observe(startedAtSec, endedAtSec);
		const clusterSpans = perTurn.get(turn.idx) ?? [];
		const turnRow: TurnRow = {
			kind: "turn",
			id: `turn-${turn.idx}`,
			depth: 0,
			idx: turn.idx,
			role: turn.role,
			startedAtSec,
			endedAtSec,
			durationMs: turn.turn_end_ms - turn.turn_start_ms,
			hasChildren: clusterSpans.length > 0,
		};
		rows.push(turnRow);
		appendSpanTree(rows, clusterSpans, turnRow.id, 1, observe);
	}

	if (untimed.length > 0) {
		const untimedRow: UntimedGroupRow = {
			kind: "untimed-group",
			id: "untimed",
			depth: 0,
			spanCount: untimed.length,
			hasChildren: true,
		};
		rows.push(untimedRow);
		for (const span of untimed) {
			const { startSec, endSec } = spanSeconds(span);
			observe(startSec, endSec);
		}
		appendSpanTree(rows, untimed, untimedRow.id, 1, observe);
	}

	const startSec = minSec === Number.POSITIVE_INFINITY ? 0 : Math.min(0, minSec);
	const endSec = maxSec === Number.NEGATIVE_INFINITY ? 1 : Math.max(maxSec, startSec + 0.001);
	const scale: TraceScale = {
		startSec,
		endSec,
		durationSec: endSec - startSec,
	};

	return { rows, scale };
}

function appendSpanTree(
	rows: TreeRow[],
	pool: readonly SpanResponse[],
	rootParentRowId: string,
	rootDepth: number,
	observe: (start: number, end: number) => void,
): void {
	const bySpanId = new Map<string, SpanResponse>();
	for (const s of pool) bySpanId.set(s.span_id, s);
	const childrenBySpanId = new Map<string, SpanResponse[]>();
	const tops: SpanResponse[] = [];
	for (const s of pool) {
		const parent = s.parent_span_id;
		if (parent !== null && bySpanId.has(parent)) {
			const bucket = childrenBySpanId.get(parent) ?? [];
			bucket.push(s);
			childrenBySpanId.set(parent, bucket);
		} else {
			tops.push(s);
		}
	}

	const visited = new Set<string>();
	const emit = (span: SpanResponse, depth: number, parentRowId: string): SpanRow => {
		visited.add(span.span_id);
		const { startSec: startedAtSec, endSec: endedAtSec } = spanSeconds(span);
		observe(startedAtSec, endedAtSec);
		const children = childrenBySpanId.get(span.span_id) ?? [];
		const reachableChildren = children.filter((c) => !visited.has(c.span_id));
		const row: SpanRow = {
			kind: "span",
			id: `span-${span.id}`,
			depth,
			name: span.name,
			vocabulary: span.vocabulary,
			startedAtSec,
			endedAtSec,
			durationMs: Math.max(0, endedAtSec * 1_000 - startedAtSec * 1_000),
			hasChildren: reachableChildren.length > 0,
			parentRowId,
			span,
		};
		rows.push(row);
		return row;
	};

	const stack: Array<{ span: SpanResponse; depth: number; parentRowId: string }> = [];
	for (let i = tops.length - 1; i >= 0; i--) {
		const span = tops[i];
		if (span === undefined) continue;
		stack.push({ span, depth: rootDepth, parentRowId: rootParentRowId });
	}

	while (stack.length > 0) {
		const frame = stack.pop();
		if (frame === undefined) continue;
		const { span, depth, parentRowId } = frame;
		if (visited.has(span.span_id)) continue;
		const row = emit(span, depth, parentRowId);
		const children = childrenBySpanId.get(span.span_id) ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child === undefined || visited.has(child.span_id)) continue;
			stack.push({ span: child, depth: depth + 1, parentRowId: row.id });
		}
	}

	// Cycle rescue: any pool span whose ancestor chain forms a loop (A→B→A)
	// has no root reachable from `tops`, so the DFS above never visits it.
	// Surface those at the root depth instead of dropping silently — the
	// data is still useful even if the parentage is malformed.
	for (const span of pool) {
		if (visited.has(span.span_id)) continue;
		emit(span, rootDepth, rootParentRowId);
	}
}
