import type { ReplayTurnResponse, SpanResponse } from "@/client/api/api.types.ts";

export type AttributionResult = Readonly<{
	perTurn: ReadonlyMap<number, readonly SpanResponse[]>;
	untimed: readonly SpanResponse[];
}>;

/**
 * Time-range attribution: a span belongs to turn `t` iff its
 * `started_at` falls inside `[replayStart + t.turn_start_ms,
 * replayStart + t.turn_end_ms]`. Spans matching no turn end up in
 * `untimed`.
 *
 * Pure function — no React, no I/O. Boundary inputs (`turns`, `spans`,
 * `replayStartIso`) are already validated by the API codec.
 */
export function attributeSpansToTurns(
	turns: readonly ReplayTurnResponse[],
	spans: readonly SpanResponse[],
	replayStartIso: string,
): AttributionResult {
	const replayStartMs = Date.parse(replayStartIso);
	const perTurn = new Map<number, SpanResponse[]>();
	const untimed: SpanResponse[] = [];

	for (const turn of turns) {
		perTurn.set(turn.idx, []);
	}

	for (const span of spans) {
		const spanStartMs = Date.parse(span.started_at) - replayStartMs;
		const owner = turns.find((t) => spanStartMs >= t.turn_start_ms && spanStartMs <= t.turn_end_ms);
		if (owner === undefined) {
			untimed.push(span);
		} else {
			const bucket = perTurn.get(owner.idx);
			if (bucket === undefined) {
				untimed.push(span);
			} else {
				bucket.push(span);
			}
		}
	}

	return { perTurn, untimed };
}

export function toReplaySeconds(isoTimestamp: string, replayStartIso: string): number {
	return (Date.parse(isoTimestamp) - Date.parse(replayStartIso)) / 1000;
}
