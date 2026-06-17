import type { ModelUsageRow, ToolCallRow } from "@/server/store/types.ts";

import type { AssertionContext } from "./assertions.types.ts";

export interface MakeAssertionContextOverrides {
	turnIdx?: number;
	turnRole?: "user" | "agent";
	transcript?: string | null;
	hasRecordingAnchor?: boolean;
	toolCalls?: readonly ToolCallRow[];
	modelUsage?: readonly ModelUsageRow[];
	agentResponseMs?: number | null;
	ttftMs?: number | null;
}

export function makeAssertionContext(
	overrides: MakeAssertionContextOverrides = {},
): AssertionContext {
	return {
		turnIdx: overrides.turnIdx ?? 0,
		turnRole: overrides.turnRole ?? "agent",
		transcript: overrides.transcript === undefined ? "" : overrides.transcript,
		// Default true: most assertion tests aren't exercising the no-anchor
		// path, and a false default would silently flip every tool test to
		// `errored`.
		hasRecordingAnchor: overrides.hasRecordingAnchor ?? true,
		toolCalls: overrides.toolCalls ?? [],
		modelUsage: overrides.modelUsage ?? [],
		metrics: {
			agentResponseMs: overrides.agentResponseMs ?? null,
			ttftMs: overrides.ttftMs ?? null,
		},
	};
}

let toolCallId = 0;

/** Builds a `ToolCallRow` with sensible defaults. Caller overrides `name`
 *  and `argsJson` for assertion fixtures. */
export function makeToolCallRow(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
	toolCallId += 1;
	return {
		id: overrides.id ?? toolCallId,
		replayId: overrides.replayId ?? "00000000-0000-0000-0000-000000000001",
		spanId: overrides.spanId ?? `span-${toolCallId}`,
		name: overrides.name ?? "lookup",
		argsJson: overrides.argsJson ?? null,
		resultJson: overrides.resultJson ?? null,
		startedAt: overrides.startedAt ?? null,
		endedAt: overrides.endedAt ?? null,
		latencyMs: overrides.latencyMs ?? null,
	};
}
