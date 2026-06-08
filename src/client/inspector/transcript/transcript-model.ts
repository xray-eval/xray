import type {
	ReplayTurnResponse,
	TranscriptWord,
	TurnRole,
	TurnTranscriptResponse,
} from "@/client/api/api.types.ts";

export interface TranscriptEntry {
	turnIdx: number;
	role: TurnRole;
	text: string;
	words: TranscriptWord[] | null;
	voiceStartMs: number;
	voiceEndMs: number;
}

/**
 * Join each transcript to its turn's voice window (by turn_idx) so a click can
 * seek the player and the playhead can light the active turn / word. Both are
 * keyed by the same VAD turn index, so a missing match shouldn't happen — when
 * it does, the entry is kept with a zero-length window rather than dropped, so
 * the text is never silently lost.
 */
export function buildTranscriptView(
	transcripts: readonly TurnTranscriptResponse[],
	turns: readonly ReplayTurnResponse[],
): TranscriptEntry[] {
	const turnByIdx = new Map(turns.map((t) => [t.idx, t]));
	return [...transcripts]
		.sort((a, b) => a.turn_idx - b.turn_idx)
		.map((t) => {
			const turn = turnByIdx.get(t.turn_idx);
			return {
				turnIdx: t.turn_idx,
				role: turn?.role ?? "user",
				text: t.text,
				words: t.words,
				voiceStartMs: turn?.voice_start_ms ?? 0,
				voiceEndMs: turn?.voice_end_ms ?? 0,
			};
		});
}

/** Index of the entry whose voice window contains `sec`, or -1 when none do. */
export function activeTurnIndex(entries: readonly TranscriptEntry[], sec: number): number {
	const ms = sec * 1000;
	return entries.findIndex((e) => ms >= e.voiceStartMs && ms < e.voiceEndMs);
}

/** Index of the word whose [start_ms, end_ms) window contains `ms`, or -1. */
export function activeWordIndex(words: readonly TranscriptWord[] | null, ms: number): number {
	if (words === null) return -1;
	return words.findIndex((w) => ms >= w.start_ms && ms < w.end_ms);
}

/**
 * Index of the active word for a playhead expressed in recording-absolute ms.
 * Word timings are 0-based within the turn's audio slice (Whisper transcribes
 * the per-turn slice cut at `voice_start_ms`), so the absolute playhead is
 * shifted by `voiceStartMs` before matching — otherwise no word ever lights up
 * on any turn that doesn't start at recording t=0.
 */
export function activeWordIndexForEntry(entry: TranscriptEntry, playheadMs: number): number {
	return activeWordIndex(entry.words, playheadMs - entry.voiceStartMs);
}
