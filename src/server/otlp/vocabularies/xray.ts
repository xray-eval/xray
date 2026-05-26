import type { ProjectedSpan } from "../otlp.types.ts";
import { pickPrefixed } from "./attrs.ts";
import type { SpanVocabularyMatcher, VocabularyExtraction } from "./vocabularies.types.ts";

/**
 * Vocabulary: `xray.*` — spans the xray SDK or driver emits.
 *
 * Assertions + judges now run server-side from the conversation declaration;
 * `xray.assertion` and `xray.judge` were dropped from the recognized set as
 * part of spec 0001. The driver may still emit `xray.turn` and `xray.stage.*`
 * spans — they land in the raw `spans` table for the inspector's timeline
 * but the server doesn't extract structured rows from them.
 */
const XRAY_RECOGNIZED_NAMES = ["xray.turn", "xray.stage.stt", "xray.stage.tts"] as const;

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
