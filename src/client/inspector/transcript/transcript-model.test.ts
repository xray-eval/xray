import type {
	ReplayTurnResponse,
	TranscriptWord,
	TurnTranscriptResponse,
} from "@/client/api/api.types.ts";

import { activeTurnIndex, activeWordIndex, buildTranscriptView } from "./transcript-model.ts";
import { describe, expect, it } from "bun:test";

function turn(overrides: Partial<ReplayTurnResponse>): ReplayTurnResponse {
	return {
		idx: 0,
		role: "user",
		turn_start_ms: 0,
		turn_end_ms: 1000,
		voice_start_ms: 100,
		voice_end_ms: 900,
		...overrides,
	};
}

function transcript(overrides: Partial<TurnTranscriptResponse>): TurnTranscriptResponse {
	return {
		turn_idx: 0,
		text: "hi",
		language: "en",
		words: null,
		duration_ms: 800,
		provider: "openai_whisper",
		model: "whisper-1",
		...overrides,
	};
}

describe("buildTranscriptView", () => {
	it("joins transcripts to their turn's role and voice window, ordered by turn_idx", () => {
		const entries = buildTranscriptView(
			[transcript({ turn_idx: 1, text: "hello" }), transcript({ turn_idx: 0, text: "hi" })],
			[
				turn({ idx: 0, role: "user", voice_start_ms: 100, voice_end_ms: 900 }),
				turn({ idx: 1, role: "agent", voice_start_ms: 1100, voice_end_ms: 2000 }),
			],
		);
		expect(entries.map((e) => e.turnIdx)).toEqual([0, 1]);
		expect(entries[0]?.role).toBe("user");
		expect(entries[1]?.role).toBe("agent");
		expect(entries[1]?.voiceStartMs).toBe(1100);
	});

	it("keeps a transcript whose turn is missing with a zero-length window", () => {
		const entries = buildTranscriptView([transcript({ turn_idx: 5, text: "orphan" })], []);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.voiceStartMs).toBe(0);
		expect(entries[0]?.voiceEndMs).toBe(0);
	});
});

describe("activeTurnIndex", () => {
	const entries = buildTranscriptView(
		[transcript({ turn_idx: 0 }), transcript({ turn_idx: 1 })],
		[
			turn({ idx: 0, voice_start_ms: 100, voice_end_ms: 900 }),
			turn({ idx: 1, voice_start_ms: 1100, voice_end_ms: 2000 }),
		],
	);

	it("returns the index whose voice window contains the playhead", () => {
		expect(activeTurnIndex(entries, 1.5)).toBe(1);
	});

	it("returns -1 in a gap between turns", () => {
		expect(activeTurnIndex(entries, 1.0)).toBe(-1);
	});
});

describe("activeWordIndex", () => {
	const words: TranscriptWord[] = [
		{ text: "hello", start_ms: 100, end_ms: 400 },
		{ text: "there", start_ms: 410, end_ms: 700 },
	];

	it("finds the word covering the given ms", () => {
		expect(activeWordIndex(words, 500)).toBe(1);
	});

	it("returns -1 when words are null or no word covers the ms", () => {
		expect(activeWordIndex(null, 500)).toBe(-1);
		expect(activeWordIndex(words, 405)).toBe(-1);
	});
});
