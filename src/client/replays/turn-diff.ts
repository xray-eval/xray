import type { ReplayTurnResponse } from "../api/api.types.ts";

/**
 * Aligns the per-turn VAD output of N replays by `idx` and flags cells that
 * diverge from the first-present baseline. Two replays of the same Conversation
 * with the same run_config drift on agent timing/role — this is the signal a
 * dev opens Compare to see.
 *
 * VAD turn `idx` is dense (server `deriveTurns` merges same-role segments and
 * numbers from 0), so it's a stable alignment key across replays even when
 * agent output diverges and one run produces an extra turn.
 */
export interface TurnDiffCell {
	readonly present: boolean;
	readonly turn: ReplayTurnResponse | undefined;
	readonly differsFromBaseline: boolean;
}

export interface TurnDiffRow {
	readonly idx: number;
	readonly cells: readonly TurnDiffCell[];
}

export function diffTurns(
	turnsByReplay: readonly (readonly ReplayTurnResponse[])[],
): readonly TurnDiffRow[] {
	const maps = turnsByReplay.map((turns) => new Map(turns.map((t) => [t.idx, t] as const)));
	const allIdxs = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
	return allIdxs.map((idx) => {
		const cells = maps.map((m) => {
			const turn = m.get(idx);
			return { present: turn !== undefined, turn };
		});
		const baseline = cells.find((c) => c.present);
		return {
			idx,
			cells: cells.map((cell) => ({
				...cell,
				differsFromBaseline: baseline === undefined ? false : !turnsMatch(cell.turn, baseline.turn),
			})),
		};
	});
}

function turnsMatch(a: ReplayTurnResponse | undefined, b: ReplayTurnResponse | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return (
		a.role === b.role && a.voice_start_ms === b.voice_start_ms && a.voice_end_ms === b.voice_end_ms
	);
}
