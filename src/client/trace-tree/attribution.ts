import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";
import { clampedTurnWindows, offsetInTurnWindow } from "@/server/replays/timeline.ts";

export type AttributionResult = Readonly<{
	perTurn: ReadonlyMap<number, readonly SpanResponse[]>;
	untimed: readonly SpanResponse[];
}>;

/**
 * Group spans under the turn that owns their audio-timeline offset, for DISPLAY
 * clustering in the trace tree. A span belongs to turn `t` iff its
 * server-derived `audio_offset_ms` falls in `t`'s clamped attribution window
 * `[turnStartMs, turnEndMs)` — the SAME windows and half-open rule the
 * assertion evaluator uses (`clampedTurnWindows` / `offsetInTurnWindow` from
 * `@/server/replays/timeline.ts`), so the inspector can never cluster a
 * tool/model span under a different turn than the one its assertion was scored
 * against.
 *
 * Spans with a null `audio_offset_ms` (the replay has no recording anchor, so
 * nothing is placeable) land in `untimed` — never silently shifted onto a
 * fallback origin (spec 0001 §3.1).
 *
 * Pure function — no React, no I/O. Boundary inputs are already validated by the
 * API codec.
 */
export function attributeSpansToTurns(
	turns: readonly ReplayTurnResponse[],
	spans: readonly SpanResponse[],
): AttributionResult {
	const windows = clampedTurnWindows(turns.map((t) => t.turn_end_ms));
	const perTurn = new Map<number, SpanResponse[]>();
	for (const turn of turns) perTurn.set(turn.idx, []);
	const untimed: SpanResponse[] = [];

	for (const span of spans) {
		const offset = span.audio_offset_ms;
		const ownerIdx = offset === null ? -1 : windows.findIndex((w) => offsetInTurnWindow(offset, w));
		const owner = ownerIdx === -1 ? undefined : turns[ownerIdx];
		const bucket = owner === undefined ? undefined : perTurn.get(owner.idx);
		if (bucket === undefined) untimed.push(span);
		else bucket.push(span);
	}

	return { perTurn, untimed };
}

/**
 * Seconds from the recording's t=0 to a span's `audio_offset_ms`, the offset the
 * waveform/playhead use. Null when the span can't be placed (no anchor).
 */
export function spanStartSeconds(span: SpanResponse): number | null {
	return span.audio_offset_ms === null ? null : span.audio_offset_ms / 1000;
}
