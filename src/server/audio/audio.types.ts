import * as v from "valibot";

// Stereo WAV (48 kHz / int16 / L=user / R=agent) is the only format the
// analyze-replay processor knows how to parse — `readStereoWav` assumes a
// PCM WAV header, not a compressed container. We previously accepted
// audio/opus, audio/ogg, audio/webm, and audio/mp3 here too, but the
// processor only validated WAV format at the start of the analyze stage,
// which meant the upload succeeded but the chain failed later with
// `transcription_failed` (the wrong reason). Forcing WAV at the upload
// boundary surfaces the mismatch as a 415 at the SDK's POST instead.
export const CONTENT_TYPE_TO_EXTENSION = {
	"audio/wav": "wav",
	"audio/x-wav": "wav",
} as const satisfies Record<string, string>;

export type AudioContentType = keyof typeof CONTENT_TYPE_TO_EXTENSION;
export type AudioExtension = (typeof CONTENT_TYPE_TO_EXTENSION)[AudioContentType];

const ALL_CONTENT_TYPES = [
	"audio/wav",
	"audio/x-wav",
] as const satisfies readonly AudioContentType[];

// Guards against forgetting to add a new content type to ALL_CONTENT_TYPES
// when CONTENT_TYPE_TO_EXTENSION grows — fails to compile if a key is missing.
type _AllContentTypesCovers = AudioContentType extends (typeof ALL_CONTENT_TYPES)[number]
	? true
	: never;
const _allContentTypesCovers: _AllContentTypesCovers = true;
void _allContentTypesCovers;

const ALL_EXTENSIONS = [
	...new Set(Object.values(CONTENT_TYPE_TO_EXTENSION)),
] satisfies AudioExtension[];

export const AudioContentTypeSchema = v.picklist(ALL_CONTENT_TYPES);
export const AudioExtensionSchema = v.picklist(ALL_EXTENSIONS);

export const EXTENSION_TO_RESPONSE_CONTENT_TYPE: Record<AudioExtension, string> = {
	wav: "audio/wav",
};

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export const UploadAudioResponseSchema = v.object({
	ok: v.literal(true),
	audio_path: v.string(),
});
export type UploadAudioResponse = v.InferOutput<typeof UploadAudioResponseSchema>;

// Wall-clock (UTC ISO-8601) of audio sample 0, sent as the
// `X-Recording-Started-At` request header on POST /audio. Optional — older
// SDKs omit it, in which case span→audio offsets are undefined and attribution
// is skipped (see spec 0001). When present it must be a valid ISO timestamp.
//
// The extra Date.parse gate is load-bearing: valibot's `isoTimestamp()` accepts
// forms `Date.parse` returns NaN for (e.g. an hour-only offset `…+02`, a space
// before the offset). Storing one of those would leave the replay looking
// anchored while every derived `audio_offset_ms` is null — tool/ttft assertions
// would then report a misleading pass/fail instead of `errored`. Since every
// consumer maps the anchor via `Date.parse`, reject anything it can't parse.
export const RecordingStartedAtSchema = v.pipe(
	v.string(),
	v.isoTimestamp(),
	v.check((s) => Number.isFinite(Date.parse(s)), "must be a Date.parse-able ISO-8601 timestamp"),
);

export interface AudioStream {
	readonly stream: ReadableStream<Uint8Array>;
	readonly contentLength: number;
	readonly contentType: string;
}

// Audio processing (WAV + VAD + turns). These types are the boundary between
// `audio.wav.ts`, `audio.vad.ts`, and `audio.turns.ts`.

export interface StereoWav {
	readonly sampleRate: number;
	readonly bitsPerSample: 16;
	readonly left: Int16Array;
	readonly right: Int16Array;
}

export interface VadSegment {
	readonly startMs: number;
	readonly endMs: number;
}

export interface DerivedTurn {
	readonly idx: number;
	readonly role: "user" | "agent";
	readonly turnStartMs: number;
	readonly turnEndMs: number;
	readonly voiceStartMs: number;
	readonly voiceEndMs: number;
}

export interface VadConfig {
	/** Frame size in milliseconds. 30ms is the conventional default. */
	frameDurationMs?: number;
	/** Voiced if mean squared energy per sample is above this. Tuned per fixture. */
	energyThreshold?: number;
	/** Merge adjacent voiced runs if their gap is ≤ this many ms. */
	mergeGapMs?: number;
	/** Discard voiced runs shorter than this many ms (cough, breath, noise). */
	minSegmentMs?: number;
	/** Zero-crossing-rate gate: voiced frames must have ZCR in [min, max]. */
	zcrMin?: number;
	zcrMax?: number;
}
