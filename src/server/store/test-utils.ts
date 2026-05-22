import type { Store } from "./store.ts";
import { openStore } from "./store.ts";
import type {
	ConversationInput,
	ReplayInput,
	ReplayTurnInput,
	SpanInput,
	SpeechSegmentInput,
} from "./types.ts";

/**
 * In-memory store for a single test. Each call returns a fresh DB — no
 * cleanup needed; the OS frees memory on close.
 */
export function makeTempStore(): Store {
	return openStore({ path: ":memory:" });
}

let conversationCounter = 0;
let replayCounter = 0;
let spanCounter = 0;

/** 64-char hex hash used in tests. Counter-based so each call differs. */
export function fakeHash(seed = 0): string {
	const n = (seed === 0 ? ++conversationCounter : seed).toString(16).padStart(8, "0");
	return n.repeat(8).slice(0, 64);
}

export function makeConversationInput(
	overrides: Partial<ConversationInput> = {},
): ConversationInput {
	return {
		hash: fakeHash(),
		name: "conv",
		turnsJson: JSON.stringify([{ role: "user", text: "hi", key: "u0" }]),
		createdAt: "2026-05-16T12:00:00.000Z",
		lastRunAt: "2026-05-16T12:00:00.000Z",
		...overrides,
	};
}

export function makeReplayInput(overrides: Partial<ReplayInput> = {}): ReplayInput {
	replayCounter += 1;
	return {
		id: `replay-${replayCounter}`,
		conversationHash: fakeHash(1),
		lifecycleState: "pending",
		analysisStep: null,
		failureReason: null,
		startedAt: "2026-05-16T12:00:00.000Z",
		finishedAt: null,
		audioPath: null,
		runConfigJson: null,
		jobId: null,
		...overrides,
	};
}

export function makeReplayTurnInput(overrides: Partial<ReplayTurnInput> = {}): ReplayTurnInput {
	return {
		replayId: `replay-${replayCounter}`,
		idx: 0,
		role: "user",
		turnStartMs: 0,
		turnEndMs: 1000,
		voiceStartMs: 0,
		voiceEndMs: 1000,
		...overrides,
	};
}

export function makeSpeechSegmentInput(
	overrides: Partial<SpeechSegmentInput> = {},
): SpeechSegmentInput {
	return {
		replayId: `replay-${replayCounter}`,
		channel: "user",
		startMs: 0,
		endMs: 1000,
		...overrides,
	};
}

export function makeSpanInput(overrides: Partial<SpanInput> = {}): SpanInput {
	spanCounter += 1;
	return {
		replayId: `replay-${replayCounter}`,
		traceId: `trace-${spanCounter}`,
		spanId: `span-${spanCounter}`,
		parentSpanId: null,
		name: "test.span",
		vocabulary: "xray",
		startedAt: "2026-05-16T12:00:01.000Z",
		endedAt: "2026-05-16T12:00:02.000Z",
		attributesJson: "{}",
		...overrides,
	};
}
