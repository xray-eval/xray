import type { ModelUsageRow, ToolCallRow } from "@/server/store/types.ts";

import type { JudgeEvidence, JudgeEvidenceTurn } from "./judges.evidence.ts";
import type { JudgeProvider } from "./judges.types.ts";

const REPLAY_ID = "rp_test";

/** Recording t=0 that `atOffset` measures against. */
export const EVIDENCE_T0 = "2026-05-26T14:31:31.023Z";

/** Wall-clock ISO for a given offset on the audio timeline. */
export function atOffset(ms: number): string {
	return new Date(Date.parse(EVIDENCE_T0) + ms).toISOString();
}

export function makeToolCallRow(over: Partial<ToolCallRow> = {}): ToolCallRow {
	return {
		id: 1,
		replayId: REPLAY_ID,
		spanId: "s1",
		name: "lookup_balance",
		argsJson: '{"account_id":"chk-991"}',
		resultJson: '{"balance":1204.5}',
		startedAt: atOffset(1500),
		endedAt: atOffset(1740),
		latencyMs: 240,
		...over,
	};
}

export function makeModelUsageRow(over: Partial<ModelUsageRow> = {}): ModelUsageRow {
	return {
		id: 1,
		replayId: REPLAY_ID,
		spanId: "s2",
		provider: "openai",
		model: "gpt-4o",
		inputTokens: 100,
		outputTokens: 20,
		totalTokens: 120,
		ttftMs: 320,
		startedAt: atOffset(1100),
		endedAt: atOffset(1600),
		latencyMs: 500,
		...over,
	};
}

export function makeEvidenceTurn(over: Partial<JudgeEvidenceTurn> = {}): JudgeEvidenceTurn {
	return {
		turnIdx: 0,
		role: "agent",
		text: "hello",
		toolCalls: [],
		modelUsage: [],
		metrics: null,
		...over,
	};
}

export function makeEvidence(
	turns: readonly JudgeEvidenceTurn[],
	hasRecordingAnchor = true,
): JudgeEvidence {
	return { hasRecordingAnchor, turns };
}

/**
 * Judge provider that records the prompts it was handed, so a test can assert
 * on prompt shape without exporting the SYSTEM_PROMPT constant.
 */
export interface RecordingJudgeProvider extends JudgeProvider {
	systemPrompt: string;
	userPrompt: string;
}

export function makeRecordingJudgeProvider(score = 95, reason = "matches"): RecordingJudgeProvider {
	const rec: RecordingJudgeProvider = {
		name: "fake",
		model: "fake-1",
		systemPrompt: "",
		userPrompt: "",
		judge: async (input: { systemPrompt: string; userPrompt: string }) => {
			rec.systemPrompt = input.systemPrompt;
			rec.userPrompt = input.userPrompt;
			return { score, reason };
		},
	};
	return rec;
}
