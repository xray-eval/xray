import type { ProjectedSpan } from "../otlp.types.ts";
import { pickPrefixed } from "./attrs.ts";
import type { SpanVocabularyMatcher, VocabularyExtraction } from "./vocabularies.types.ts";

/**
 * Vocabulary: `xray.*` — spans the xray SDK or driver emits.
 *
 * Recognized names below are accepted (so they land in the raw `spans` table
 * for the inspector's timeline) but NO structured row extraction happens here
 * anymore. Turn boundaries come from server-side VAD on the uploaded stereo
 * WAV; assertion + judge results will return in a follow-up PR under a
 * server-side evaluation model.
 */
const XRAY_RECOGNIZED_NAMES = [
	"xray.assertion",
	"xray.judge",
	"xray.turn",
	"xray.stage.stt",
	"xray.stage.tts",
] as const;

const XRAY_RECOGNIZED_NAMES_SET = new Set<string>(XRAY_RECOGNIZED_NAMES);

function isRecognized(name: string): boolean {
	return XRAY_RECOGNIZED_NAMES_SET.has(name);
}

export const xrayVocabulary: SpanVocabularyMatcher = (
	span: ProjectedSpan,
): VocabularyExtraction | null => {
	if (!isRecognized(span.name)) return null;
	return {
		vocabulary: "xray",
		attributes: pickPrefixed(span.attributes, "xray."),
	};
};
