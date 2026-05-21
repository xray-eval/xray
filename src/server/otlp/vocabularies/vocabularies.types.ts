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
	startedAt: string | null;
	endedAt: string | null;
	latencyMs: number | null;
}

/**
 * Output of matching a span against a vocabulary. A single span can produce
 * one or more downstream extracted rows (tool_calls, model_usage) AND should
 * be persisted as a raw span.
 *
 * xray.turn / xray.judge / xray.assertion / xray.stage spans are accepted
 * (no rejection) but no longer produce structured rows — turn/judge/assertion
 * truth lives elsewhere in the audio-ground-truth model.
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
