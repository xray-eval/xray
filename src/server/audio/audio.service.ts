import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

import { eq } from "drizzle-orm";
import * as v from "valibot";

import { findReplay } from "@/server/replays/replays.service.ts";
import { replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type { ReplayLifecycleState } from "@/server/store/types.ts";

import {
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	InvalidAudioExtensionError,
	ReplayUploadStateError,
} from "./audio.errors.ts";
import type { AudioContentType, AudioExtension, AudioStream } from "./audio.types.ts";
import {
	AudioExtensionSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
} from "./audio.types.ts";

// States in which a fresh audio upload is safe. `analyzing` is excluded
// because the worker is reading the previous WAV and writing derived rows in
// the same transaction; overwriting underneath it would race. `completed` /
// `failed` are excluded because they're terminal — unwinding lifecycle would
// leave stale `replay_turns` + `speech_segments` from the previous analysis.
const UPLOAD_ALLOWED_STATES: readonly ReplayLifecycleState[] = [
	"pending",
	"running",
	"recording_uploaded",
];

/**
 * Save a recorded conversation-input audio file under a content-addressed
 * path (`recorded/<sha256>.wav`). Idempotent: same bytes ⇒ same file.
 *
 * Writes to a per-call tmp file then `rename(2)` atomically into place, so
 * a concurrent upload of the same content can never observe a half-written
 * target (the previous `writeFile(flag: "wx")` strategy returned success to
 * the loser while the winner was still streaming bytes — a partial-content
 * window for readers).
 *
 * Returns the relative path under `audioRoot`. The caller is expected to
 * have already computed the sha256 from the bytes.
 */
export async function saveRecordedConversationAudio(
	audioRoot: string,
	sha256: string,
	bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const relativePath = recordedRelativePath(sha256);
	const absolutePath = resolveInsideRoot(audioRoot, relativePath);
	await mkdir(dirname(absolutePath), { recursive: true });
	const tmpPath = `${absolutePath}.tmp-${randomUUID()}`;
	try {
		await writeFile(tmpPath, bytes);
		await rename(tmpPath, absolutePath);
	} catch (err) {
		await rm(tmpPath, { force: true });
		throw err;
	}
	return relativePath;
}

function recordedRelativePath(sha256: string): string {
	return join("recorded", `${sha256}.wav`);
}

/** Upload the full-replay stereo WAV mixdown. */
export async function uploadReplayAudio(
	store: Store,
	audioRoot: string,
	params: { replayId: string; contentType: AudioContentType; bytes: Uint8Array<ArrayBuffer> },
): Promise<string> {
	const { replayId, contentType, bytes } = params;
	const existing = findReplay(store, replayId);
	if (existing === undefined) {
		throw new AudioReplayNotFoundError(replayId);
	}
	if (!UPLOAD_ALLOWED_STATES.includes(existing.lifecycleState)) {
		throw new ReplayUploadStateError(replayId, existing.lifecycleState);
	}
	const extension = CONTENT_TYPE_TO_EXTENSION[contentType];
	const relativePath = replayRelativePath(replayId, extension);
	const absolutePath = resolveInsideRoot(audioRoot, relativePath);

	const previousAudioPath = existing.audioPath;

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, bytes);

	store.db
		.update(replays)
		.set({ audioPath: relativePath, lifecycleState: "recording_uploaded" })
		.where(eq(replays.id, replayId))
		.run();

	if (previousAudioPath !== null && previousAudioPath !== relativePath) {
		await rm(resolveInsideRoot(audioRoot, previousAudioPath), { force: true });
	}
	return relativePath;
}

export async function readReplayAudio(
	store: Store,
	audioRoot: string,
	replayId: string,
): Promise<AudioStream> {
	const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
	if (row === undefined) throw new AudioReplayNotFoundError(replayId);
	if (row.audioPath === null) throw new AudioNotUploadedError(replayId);
	return readAtRelativePath(audioRoot, row.audioPath, () => new AudioNotUploadedError(replayId));
}

async function readAtRelativePath(
	audioRoot: string,
	relativePath: string,
	makeNotUploadedError: () => AudioNotUploadedError,
): Promise<AudioStream> {
	const absolutePath = resolveInsideRoot(audioRoot, relativePath);
	const file = Bun.file(absolutePath);
	if (!(await file.exists())) throw makeNotUploadedError();
	const extension = extensionFromPath(relativePath);
	return {
		stream: file.stream(),
		contentLength: file.size,
		contentType: EXTENSION_TO_RESPONSE_CONTENT_TYPE[extension],
	};
}

function replayRelativePath(replayId: string, ext: AudioExtension): string {
	return join(replayId, `replay.${ext}`);
}

function resolveInsideRoot(audioRoot: string, relativePath: string): string {
	const resolvedRoot = resolve(audioRoot);
	const resolvedTarget = resolve(resolvedRoot, relativePath);
	const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
	if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
		throw new AudioPathOutsideRootError(resolvedTarget, resolvedRoot);
	}
	return resolvedTarget;
}

function extensionFromPath(path: string): AudioExtension {
	const result = v.safeParse(AudioExtensionSchema, extname(path).slice(1));
	if (!result.success) throw new InvalidAudioExtensionError(path, result.issues);
	return result.output;
}
