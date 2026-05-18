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

export interface ExtractedAssertion {
	turnIdx: number;
	name: string;
	status: "passed" | "failed" | "errored";
	message: string | null;
	recordedAt: string;
}

export interface ExtractedJudge {
	status: "passed" | "failed" | "errored";
	score: number | null;
	reason: string | null;
	error: string | null;
}

export interface ExtractedTurnUpdate {
	idx: number;
	role: "user" | "agent";
	key: string | null;
	startedAt: string | null;
	endedAt: string | null;
	transcript: string | null;
	audioPath: string | null;
}

/**
 * Output of matching a span against a vocabulary. A single span can
 * produce multiple downstream rows — e.g. a tool-call span typically
 * carries one tool_call AND should also be persisted as a raw span.
 */
export interface VocabularyExtraction {
	vocabulary: SpanVocabulary;
	toolCalls?: ExtractedToolCall[];
	modelUsage?: ExtractedModelUsage[];
	assertions?: ExtractedAssertion[];
	judge?: ExtractedJudge;
	turnUpdates?: ExtractedTurnUpdate[];
	/** The narrowed attribute bag persisted on `spans.attributes_json`. */
	attributes: FlatAttributes;
}

/**
 * A vocabulary recognizes some span shapes and ignores others. Returning
 * `null` means "not for me" — the receiver falls through to the next
 * vocabulary, and finally drops the span if nobody claims it. The
 * vocabulary identity travels on the returned `VocabularyExtraction.vocabulary`
 * field; there's no separate `id` on the matcher itself.
 */
export type SpanVocabularyMatcher = (
	span: ProjectedSpan,
	resource: FlatAttributes,
) => VocabularyExtraction | null;
