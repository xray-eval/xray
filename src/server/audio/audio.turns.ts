import { AudioTurnsInvariantError } from "./audio.errors.ts";
import type { DerivedTurn, VadSegment } from "./audio.types.ts";

interface TaggedSegment {
	readonly startMs: number;
	readonly endMs: number;
	readonly role: "user" | "agent";
}

/**
 * Derive turn boundaries from per-channel VAD output. Segments merge into one
 * timeline; adjacent same-role segments form a turn, a role-change closes it.
 * Per turn:
 *   - `turnStartMs` = the moment after the OTHER side's last segment ended,
 *     clamped to this turn's own voice onset (0 for the very first turn).
 *   - `turnEndMs` = this side's last segment in the turn ended.
 *   - `voiceStartMs` / `voiceEndMs` = first/last speech-segment bounds in the turn.
 *
 * VAD runs per channel, so on a barge-in the two sides' `voice*` extents can
 * overlap in time; the `turnStartMs` clamp (see `buildTurn`) keeps an
 * interrupting turn from reporting a start after it was already speaking.
 */
export function deriveTurns(user: VadSegment[], agent: VadSegment[]): DerivedTurn[] {
	const all: TaggedSegment[] = [
		...user.map((s): TaggedSegment => ({ startMs: s.startMs, endMs: s.endMs, role: "user" })),
		...agent.map((s): TaggedSegment => ({ startMs: s.startMs, endMs: s.endMs, role: "agent" })),
	].sort((a, b) => a.startMs - b.startMs);

	if (all.length === 0) return [];

	const turns: DerivedTurn[] = [];
	const firstSegment = all[0];
	if (firstSegment === undefined) return turns;
	let currentRole: "user" | "agent" = firstSegment.role;
	let currentSegments: TaggedSegment[] = [firstSegment];
	let prevOtherEndMs = 0;

	for (let i = 1; i < all.length; i++) {
		const seg = all[i];
		if (seg === undefined) continue;
		if (seg.role === currentRole) {
			currentSegments.push(seg);
		} else {
			turns.push(buildTurn(turns.length, currentRole, currentSegments, prevOtherEndMs));
			const lastInPrev = currentSegments[currentSegments.length - 1];
			prevOtherEndMs = lastInPrev !== undefined ? lastInPrev.endMs : prevOtherEndMs;
			currentRole = seg.role;
			currentSegments = [seg];
		}
	}
	turns.push(buildTurn(turns.length, currentRole, currentSegments, prevOtherEndMs));
	return turns;
}

function buildTurn(
	idx: number,
	role: "user" | "agent",
	segments: TaggedSegment[],
	prevOtherEndMs: number,
): DerivedTurn {
	const first = segments[0];
	const last = segments[segments.length - 1];
	if (first === undefined || last === undefined) {
		throw new AudioTurnsInvariantError("buildTurn called with empty segments");
	}
	return {
		idx,
		role,
		// Clamp to this turn's voice onset so an interrupting turn (voice
		// starting before the other side stopped) can't report a start later
		// than its own first word. Without overlap `prevOtherEndMs` is already
		// ≤ the voice onset, so the `min` is a no-op for the common path.
		turnStartMs: Math.min(prevOtherEndMs, first.startMs),
		turnEndMs: last.endMs,
		voiceStartMs: first.startMs,
		voiceEndMs: last.endMs,
	};
}
