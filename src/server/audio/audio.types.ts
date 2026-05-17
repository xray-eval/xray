import * as v from "valibot";

/**
 * Container formats `<audio>` can decode in every modern browser, mapped to
 * the canonical filename extension we persist them under. Aliases
 * (`audio/mpeg` ↔ `audio/mp3`, `audio/x-wav` ↔ `audio/wav`) collapse onto
 * the canonical extension so two uploads with different headers but the
 * same bytes land at the same file path.
 */
export const CONTENT_TYPE_TO_EXTENSION = {
	"audio/opus": "opus",
	"audio/ogg": "ogg",
	"audio/webm": "webm",
	"audio/mp3": "mp3",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
} as const satisfies Record<string, string>;

export type AudioContentType = keyof typeof CONTENT_TYPE_TO_EXTENSION;
export type AudioExtension = (typeof CONTENT_TYPE_TO_EXTENSION)[AudioContentType];

const ALL_CONTENT_TYPES = [
	"audio/opus",
	"audio/ogg",
	"audio/webm",
	"audio/mp3",
	"audio/mpeg",
	"audio/wav",
	"audio/x-wav",
] as const satisfies readonly AudioContentType[];

const ALL_EXTENSIONS = [
	...new Set(Object.values(CONTENT_TYPE_TO_EXTENSION)),
] satisfies AudioExtension[];

export const AudioContentTypeSchema = v.picklist(ALL_CONTENT_TYPES);
export const AudioExtensionSchema = v.picklist(ALL_EXTENSIONS);

/**
 * Reverse map for response Content-Type. `.mp3` could legally be either
 * `audio/mp3` or `audio/mpeg` — we pick the IANA-registered one.
 */
export const EXTENSION_TO_RESPONSE_CONTENT_TYPE: Record<AudioExtension, string> = {
	opus: "audio/opus",
	ogg: "audio/ogg",
	webm: "audio/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
};

/** 50 MB — past the issue's 5 MB / 15-min Opus baseline; capped so a
 *  misbehaving client can't OOM the process with one POST. */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const MAX_TURN_IDX = 1_000_000;
export const TurnIdxParamSchema = v.pipe(
	v.string(),
	v.regex(/^[0-9]+$/),
	v.transform((s) => Number(s)),
	v.integer(),
	v.minValue(0),
	v.maxValue(MAX_TURN_IDX),
);

export const UploadAudioResponseSchema = v.object({
	ok: v.literal(true),
	audioPath: v.string(),
});
export type UploadAudioResponse = v.InferOutput<typeof UploadAudioResponseSchema>;
