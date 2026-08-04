import {
	assertionResults,
	conversations,
	modelUsage,
	replayEvaluations,
	replays,
	spans,
	toolCalls,
} from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { assertExtractedRows, assertReplayIsGreen } from "./seed-snapshot.verify.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const REPLAY_ID = "replay-under-test";
const CONVERSATION_HASH = "c".repeat(64);

let store: Store;

beforeEach(() => {
	store = makeTempStore();
	store.db
		.insert(conversations)
		.values({
			hash: CONVERSATION_HASH,
			name: "fixture",
			turnsJson: "[]",
			createdAt: "2026-07-01T12:00:00.000Z",
			lastRunAt: "2026-07-01T12:00:00.000Z",
		})
		.run();
	store.db
		.insert(replays)
		.values({
			id: REPLAY_ID,
			conversationHash: CONVERSATION_HASH,
			lifecycleState: "completed",
			startedAt: "2026-07-01T12:00:00.000Z",
		})
		.run();
});

afterEach(() => store.close());

function addSpan(spanId: string, vocabulary: "xray" | "gen_ai" | "langfuse"): void {
	store.db
		.insert(spans)
		.values({
			replayId: REPLAY_ID,
			traceId: "t",
			spanId,
			parentSpanId: null,
			name: spanId,
			vocabulary,
			startedAt: "2026-07-01T12:00:01.000Z",
			endedAt: "2026-07-01T12:00:02.000Z",
			attributesJson: "{}",
		})
		.run();
}

function addModelUsage(
	overrides: { inputTokens?: number | null; ttftMs?: number | null } = {},
): void {
	store.db
		.insert(modelUsage)
		.values({
			replayId: REPLAY_ID,
			spanId: "chat",
			provider: "openai",
			model: "gpt-4o",
			inputTokens: overrides.inputTokens === undefined ? 602 : overrides.inputTokens,
			outputTokens: 39,
			totalTokens: 641,
			ttftMs: overrides.ttftMs === undefined ? 150 : overrides.ttftMs,
			startedAt: "2026-07-01T12:00:01.000Z",
			endedAt: "2026-07-01T12:00:02.000Z",
			latencyMs: 280,
		})
		.run();
}

function addToolCall(): void {
	store.db
		.insert(toolCalls)
		.values({
			replayId: REPLAY_ID,
			spanId: "tool",
			name: "book_flight",
			argsJson: "{}",
			resultJson: "{}",
			startedAt: "2026-07-01T12:00:01.000Z",
			endedAt: "2026-07-01T12:00:02.000Z",
			latencyMs: 82,
		})
		.run();
}

function addAssertion(overrides: { status?: "passed" | "failed"; idx?: number } = {}): void {
	store.db
		.insert(assertionResults)
		.values({
			replayId: REPLAY_ID,
			turnIdx: 1,
			assertionIdx: overrides.idx ?? 0,
			kind: "tool_called",
			paramsJson: "{}",
			status: overrides.status ?? "passed",
			message: null,
			evaluatedAt: "2026-07-01T12:00:09.400Z",
		})
		.run();
}

function addVerdict(passed: boolean): void {
	store.db
		.insert(replayEvaluations)
		.values({
			replayId: REPLAY_ID,
			passed,
			assertionsTotal: 1,
			assertionsPassed: passed ? 1 : 0,
			judgesTotal: 0,
			judgesPassed: 0,
			evaluatedAt: "2026-07-01T12:00:09.400Z",
		})
		.run();
}

const EXPECTED = { replayId: REPLAY_ID, spans: 2, modelUsage: 1, toolCalls: 1 };

describe("assertExtractedRows", () => {
	it("accepts a replay whose extracted rows match the trace it ingested", () => {
		addSpan("chat", "gen_ai");
		addSpan("tool", "gen_ai");
		addModelUsage();
		addToolCall();
		expect(() => assertExtractedRows(store.db, EXPECTED)).not.toThrow();
	});

	// The failure the ingest-time span count can't see: the spans are recognized
	// and persisted, but the vocabulary extracted nothing from them.
	it("rejects recognized spans that produced no model_usage row", () => {
		addSpan("chat", "gen_ai");
		addSpan("tool", "gen_ai");
		addToolCall();
		expect(() => assertExtractedRows(store.db, EXPECTED)).toThrow(
			/has 0 modelUsage rows, expected 1/,
		);
	});

	it("rejects recognized spans that produced no tool_calls row", () => {
		addSpan("chat", "gen_ai");
		addSpan("tool", "gen_ai");
		addModelUsage();
		expect(() => assertExtractedRows(store.db, EXPECTED)).toThrow(/has 0 toolCalls rows/);
	});

	it("rejects a short span count", () => {
		addSpan("chat", "gen_ai");
		addModelUsage();
		addToolCall();
		expect(() => assertExtractedRows(store.db, EXPECTED)).toThrow(/has 1 spans rows, expected 2/);
	});

	// A row with the right shape but no numbers is the regression that would
	// empty the inspector's token bars without failing anything else.
	it("rejects a model_usage row with null tokens", () => {
		addSpan("chat", "gen_ai");
		addSpan("tool", "gen_ai");
		addModelUsage({ inputTokens: null });
		addToolCall();
		expect(() => assertExtractedRows(store.db, EXPECTED)).toThrow(
			/model_usage rows with null tokens or ttft/,
		);
	});

	it("rejects a model_usage row with no ttft", () => {
		addSpan("chat", "gen_ai");
		addSpan("tool", "gen_ai");
		addModelUsage({ ttftMs: null });
		addToolCall();
		expect(() => assertExtractedRows(store.db, EXPECTED)).toThrow(
			/model_usage rows with null tokens or ttft/,
		);
	});
});

describe("assertReplayIsGreen", () => {
	it("accepts a replay whose declared assertions all passed", () => {
		addAssertion();
		addVerdict(true);
		expect(() => assertReplayIsGreen(store.db, REPLAY_ID, 1)).not.toThrow();
	});

	it("rejects a failing assertion, naming the turn and kind", () => {
		addAssertion({ status: "failed" });
		addVerdict(false);
		expect(() => assertReplayIsGreen(store.db, REPLAY_ID, 1)).toThrow(/turn 1 tool_called=failed/);
	});

	// "Nothing failed" is trivially true when a regression stops evaluating.
	it("rejects a replay that evaluated fewer assertions than it declares", () => {
		addVerdict(true);
		expect(() => assertReplayIsGreen(store.db, REPLAY_ID, 1)).toThrow(
			/evaluated 0 assertions, expected 1/,
		);
	});

	it("rejects a red verdict even when every assertion row passed", () => {
		addAssertion();
		addVerdict(false);
		expect(() => assertReplayIsGreen(store.db, REPLAY_ID, 1)).toThrow(/verdict is false/);
	});

	it("rejects a replay with no verdict row at all", () => {
		addAssertion();
		expect(() => assertReplayIsGreen(store.db, REPLAY_ID, 1)).toThrow(/verdict is undefined/);
	});
});
