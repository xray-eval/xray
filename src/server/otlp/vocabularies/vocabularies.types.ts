import type { SpanVocabulary } from "@/server/store/types.ts";

import type { FlatAttributes, ProjectedSpan } from "../otlp.types.ts";

export type { SpanVocabulary };

export interface ExtractedToolCall {
	name: string;
	argsJson: string | null;
	resultJson: string | null;
	startedAt: string | null;
	endedAt: string | null;
	latencyMs: number | null;
}

export interface ExtractedModelUsage {
	provider: string | null;
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	/** Model time-to-first-token (ms), from `gen_ai.response.time_to_first_chunk`
	 *  (seconds). Optional, like the token counts — null when unemitted. */
	ttftMs: number | null;
	startedAt: string | null;
	endedAt: string | null;
	latencyMs: number | null;
}

/**
 * Output of matching a span against a vocabulary. A single span can produce
 * one or more downstream extracted rows (tool_calls, model_usage) AND should
 * be persisted as a raw span.
 *
 * xray.turn / xray.stage.* spans are accepted (no rejection) but produce no
 * structured rows. xray.assertion / xray.judge were dropped from the
 * recognized set in spec 0001 — assertion + judge results live in their own
 * tables, written by the evaluate-replay job.
 */
export interface VocabularyExtraction {
	vocabulary: SpanVocabulary;
	toolCalls?: ExtractedToolCall[];
	modelUsage?: ExtractedModelUsage[];
	/** The narrowed attribute bag persisted on `spans.attributes_json`. */
	attributes: FlatAttributes;
}

export type SpanVocabularyMatcher = (
	span: ProjectedSpan,
	resource: FlatAttributes,
) => VocabularyExtraction | null;
