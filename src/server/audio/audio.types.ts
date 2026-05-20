import * as v from "valibot";

/** Aliases (`audio/mpeg` ↔ `audio/mp3`, `audio/x-wav` ↔ `audio/wav`)
 *  collapse onto one extension so two headers, same bytes → same file. */
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

/** `.mp3` could legally be `audio/mp3` or `audio/mpeg` — pick the
 *  IANA-registered one for the response. */
export const EXTENSION_TO_RESPONSE_CONTENT_TYPE: Record<AudioExtension, string> = {
	opus: "audio/opus",
	ogg: "audio/ogg",
	webm: "audio/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
};

/** Capped so a misbehaving client can't OOM the process with one POST. */
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

/** OpenAPI-shape mirror (no transform) so docs render correctly. */
export const TurnIdxParamDocSchema = v.pipe(v.string(), v.regex(/^[0-9]+$/));

export const UploadAudioResponseSchema = v.object({
	ok: v.literal(true),
	audio_path: v.string(),
});
export type UploadAudioResponse = v.InferOutput<typeof UploadAudioResponseSchema>;

export interface AudioStream {
	readonly stream: ReadableStream<Uint8Array>;
	readonly contentLength: number;
	readonly contentType: string;
}
