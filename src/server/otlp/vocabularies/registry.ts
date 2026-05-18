import { genAiSemconvVocabulary } from "./gen-ai-semconv.ts";
import { langfuseVocabulary } from "./langfuse.ts";
import type { SpanVocabularyMatcher } from "./vocabularies.types.ts";
import { xrayVocabulary } from "./xray.ts";

/**
 * Order matters: the first matcher to return non-null claims the span.
 * `xray` first because xray spans are an internal contract; then OTel
 * GenAI semconv (the canonical OTel-shaped data); then Langfuse.
 *
 * Adding a vocabulary is a new file under `vocabularies/` plus one line
 * here — no other slice changes.
 */
export const SPAN_VOCABULARIES: readonly SpanVocabularyMatcher[] = [
	xrayVocabulary,
	genAiSemconvVocabulary,
	langfuseVocabulary,
];
