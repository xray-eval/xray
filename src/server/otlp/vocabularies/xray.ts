import { match, P } from "ts-pattern";

import type { FlatAttributes, ProjectedSpan } from "../otlp.types.ts";
import { asInteger, asString, pickPrefixed } from "./attrs.ts";
import type {
	ExtractedAssertion,
	ExtractedJudge,
	ExtractedTurnUpdate,
	SpanVocabularyMatcher,
	VocabularyExtraction,
} from "./vocabularies.types.ts";

/**
 * Vocabulary: `xray.*` — spans the xray SDK itself emits.
 *
 * - `xray.assertion` — per-turn predicate result. Attributes:
 *     xray.assertion.name, xray.assertion.status, xray.assertion.message?,
 *     xray.turn.idx
 * - `xray.judge` — per-replay judge result. Attributes:
 *     xray.judge.status, xray.judge.score?, xray.judge.reason?, xray.judge.error?
 * - `xray.turn` — per-turn timing/transcript update. Attributes:
 *     xray.turn.idx, xray.turn.role, xray.turn.key?, xray.turn.transcript?,
 *     xray.turn.audio_path?
 * - `xray.stage.stt` / `xray.stage.tts` — STT/TTS stage timing. Persisted
 *     as raw spans only; no extracted rows. The span tree in the inspector
 *     surfaces them via vocabulary='xray'.
 */
const XRAY_RECOGNIZED_NAMES = [
	"xray.assertion",
	"xray.judge",
	"xray.turn",
	"xray.stage.stt",
	"xray.stage.tts",
] as const;

type XrayRecognizedName = (typeof XRAY_RECOGNIZED_NAMES)[number];

const XRAY_RECOGNIZED_NAMES_SET = new Set<string>(XRAY_RECOGNIZED_NAMES);

function isRecognized(name: string): name is XrayRecognizedName {
	return XRAY_RECOGNIZED_NAMES_SET.has(name);
}

export const xrayVocabulary: SpanVocabularyMatcher = (
	span: ProjectedSpan,
): VocabularyExtraction | null => {
	if (!isRecognized(span.name)) return null;
	const a = span.attributes;
	const narrowed: FlatAttributes = pickPrefixed(a, "xray.");
	const out: VocabularyExtraction = { vocabulary: "xray", attributes: narrowed };

	match(span.name)
		.with("xray.assertion", () => {
			const name = asString(a["xray.assertion.name"]);
			const status = asAssertionStatus(a["xray.assertion.status"]);
			const turnIdx = asInteger(a["xray.turn.idx"]);
			if (name !== null && status !== null && turnIdx !== null) {
				const assertion: ExtractedAssertion = {
					turnIdx,
					name,
					status,
					message: asString(a["xray.assertion.message"]),
					recordedAt: span.endedAt,
				};
				out.assertions = [assertion];
			}
		})
		.with("xray.judge", () => {
			const status = asJudgeStatus(a["xray.judge.status"]);
			if (status !== null) {
				const judge: ExtractedJudge = {
					status,
					score: asInteger(a["xray.judge.score"]),
					reason: asString(a["xray.judge.reason"]),
					error: asString(a["xray.judge.error"]),
				};
				out.judge = judge;
			}
		})
		.with("xray.turn", () => {
			const turnIdx = asInteger(a["xray.turn.idx"]);
			const role = asTurnRole(a["xray.turn.role"]);
			if (turnIdx !== null && role !== null) {
				const update: ExtractedTurnUpdate = {
					idx: turnIdx,
					role,
					key: asString(a["xray.turn.key"]),
					startedAt: span.startedAt,
					endedAt: span.endedAt,
					transcript: asString(a["xray.turn.transcript"]),
					audioPath: asString(a["xray.turn.audio_path"]),
				};
				out.turnUpdates = [update];
			}
		})
		.with(P.union("xray.stage.stt", "xray.stage.tts"), () => {
			// Raw span only — surfaced in the inspector via vocabulary='xray'.
		})
		.exhaustive();

	return out;
};

function asAssertionStatus(
	v: FlatAttributes[string] | undefined,
): "passed" | "failed" | "errored" | null {
	const s = asString(v);
	return s === "passed" || s === "failed" || s === "errored" ? s : null;
}

function asJudgeStatus(
	v: FlatAttributes[string] | undefined,
): "passed" | "failed" | "errored" | null {
	const s = asString(v);
	return s === "passed" || s === "failed" || s === "errored" ? s : null;
}

function asTurnRole(v: FlatAttributes[string] | undefined): "user" | "agent" | null {
	const s = asString(v);
	return s === "user" || s === "agent" ? s : null;
}
