import * as v from "valibot";

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

export const EXTENSION_TO_RESPONSE_CONTENT_TYPE: Record<AudioExtension, string> = {
	opus: "audio/opus",
	ogg: "audio/ogg",
	webm: "audio/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
};

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

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
