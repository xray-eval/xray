/**
 * Audio-timeline coordinate mapping. The single place that converts a span's
 * wall-clock `started_at` into an offset on the audio timeline (ms from the
 * recording's t=0), and decides which turn's window an offset falls in.
 *
 * See `docs/specs/0001-timeline-clock-alignment.md`. The origin is ALWAYS
 * `replays.recording_started_at` (the driver's audio sample-0 wall-clock) —
 * never `replays.started_at`, which is row-creation time and precedes the
 * recording by the room-connect + agent-join latency.
 */

/**
 * Offset of a wall-clock ISO timestamp on the audio timeline, in ms from the
 * recording's t=0.
 *
 * Returns `null` when either input is missing or unparseable — callers MUST
 * treat `null` as "cannot place this span" and skip attribution, NOT fall back
 * to a different origin.
 */
export function audioOffsetMs(
	startedAtIso: string | null,
	recordingStartedAtIso: string | null,
): number | null {
	if (recordingStartedAtIso === null) return null;
	const origin = Date.parse(recordingStartedAtIso);
	if (!Number.isFinite(origin)) return null;
	return offsetFromOriginMs(startedAtIso, origin);
}

/**
 * Offset of a wall-clock ISO timestamp from a pre-parsed origin (epoch ms), or
 * null if `startedAtIso` is missing/unparseable. Lets a read path that places
 * many rows against one replay's origin parse that origin once instead of
 * re-parsing the same string per row.
 */
export function offsetFromOriginMs(
	startedAtIso: string | null,
	originMs: number | null,
): number | null {
	if (startedAtIso === null || originMs === null) return null;
	const start = Date.parse(startedAtIso);
	if (!Number.isFinite(start)) return null;
	return start - originMs;
}

/**
 * An attribution window on the audio timeline: the half-open ms range a turn
 * owns for span/tool/model membership. NOT the same as a turn's display extent
 * (`turn_start_ms`/`turn_end_ms`), which may overlap a neighbour visually — see
 * `clampedTurnWindows` for why attribution windows must tile while display
 * bars need not.
 */
export interface TurnWindow {
	readonly turnStartMs: number;
	readonly turnEndMs: number;
}

/** True iff `offsetMs` falls in `[turnStartMs, turnEndMs)`. */
export function offsetInTurnWindow(offsetMs: number, turn: TurnWindow): boolean {
	return offsetMs >= turn.turnStartMs && offsetMs < turn.turnEndMs;
}

/**
 * Build the tiling attribution windows for a replay's turns, in `idx` order,
 * from each turn's `voiceEndMs`.
 *
 * The naive rule "turnStartMs = previous turn's voiceEndMs, turnEndMs = this
 * turn's voiceEndMs" tiles cleanly ONLY when VAD turns strictly interleave. Per
 * channel VAD plus barge-in (overlapping user/agent speech — the case the
 * `interrupted` metric flags) produces non-monotonic `voiceEndMs`, which makes
 * raw windows invert (`start > end`) or overlap, so one tool call lands in two
 * turns and a fully-barged-over turn gets a window that can never match.
 *
 * A monotonic cursor fixes both: each window starts where the previous ended
 * and ends at `max(cursor, voiceEndMs)`. An interrupted turn collapses to an
 * empty `[c, c)` window (no rows attributed — correct, it was talked over) and
 * the overlap region goes to the earlier turn (the ownership the deleted stored
 * `turn_idx` backfill gave it). The result always tiles: every offset falls in
 * exactly one window. Shared by the server evaluator and the client trace tree
 * so attribution can never diverge between them.
 */
export function clampedTurnWindows(turnEndsMs: readonly number[]): TurnWindow[] {
	const windows: TurnWindow[] = [];
	let cursor = 0;
	for (const end of turnEndsMs) {
		const turnEndMs = Math.max(cursor, end);
		windows.push({ turnStartMs: cursor, turnEndMs });
		cursor = turnEndMs;
	}
	return windows;
}

/**
 * The subset of `rows` whose `started_at` maps to an offset inside the turn's
 * window. Used by the assertion evaluator to build a turn's tool/model context
 * at eval time (replacing the deleted stored `turn_idx`).
 *
 * A row with no `started_at`, or when `recordingStartedAtIso` is null, is
 * dropped — it cannot be placed on the timeline. The caller distinguishes
 * "no anchor at all" (→ errored assertion) from "anchor present, row simply
 * out of window" (→ failed assertion); this function only does geometry.
 */
export function rowsInTurnWindow<T extends { readonly startedAt: string | null }>(
	rows: readonly T[],
	turn: TurnWindow,
	recordingStartedAtIso: string | null,
): T[] {
	return rows.filter((row) => {
		const offset = audioOffsetMs(row.startedAt, recordingStartedAtIso);
		return offset !== null && offsetInTurnWindow(offset, turn);
	});
}
