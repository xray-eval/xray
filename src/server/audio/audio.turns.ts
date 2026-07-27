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
 *   - `turnStartMs` = the moment after the OTHER side's last segment ended
 *     (0 for the very first turn).
 *   - `turnEndMs` = this side's last segment in the turn ended.
 *   - `voiceStartMs` / `voiceEndMs` = first/last speech-segment bounds in the turn.
 *
 * Overlap (both channels voiced at the same offset) is not modeled by v0 — VAD
 * runs per channel independently, assuming strict interleaving. On overlap, the
 * channel that started first owns the turn until it stops; the other side's
 * segments inside that range merge into the next turn at the role-change.
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
		turnStartMs: prevOtherEndMs,
		turnEndMs: last.endMs,
		voiceStartMs: first.startMs,
		voiceEndMs: last.endMs,
	};
}
