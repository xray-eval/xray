import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import * as v from "valibot";

import type { Store } from "@/server/store/store.ts";
import { getTurnByIdx, setTurnAudioPath } from "@/server/store/turns-repo.ts";

import { AudioNotUploadedError, AudioTurnNotFoundError } from "./audio.errors.ts";
import type { AudioContentType, AudioExtension, AudioStream } from "./audio.types.ts";
import {
	AudioExtensionSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
} from "./audio.types.ts";

/**
 * Upload a turn's audio. Writes the file then UPDATEs `turns.audio_path`
 * guarded on the turn's existence; if the row vanished mid-write, the new
 * file is rm'd and `AudioTurnNotFoundError` propagates. On a re-upload that
 * changes the extension, the previous file is removed once the new one
 * lands so on-disk state matches the column.
 */
export async function uploadTurnAudio(
	store: Store,
	audioRoot: string,
	params: {
		sessionId: string;
		turnIdx: number;
		contentType: AudioContentType;
		bytes: Uint8Array<ArrayBuffer>;
	},
): Promise<string> {
	const { sessionId, turnIdx, contentType, bytes } = params;
	const extension = CONTENT_TYPE_TO_EXTENSION[contentType];
	const relativePath = audioRelativePath(sessionId, turnIdx, extension);
	const absolutePath = join(audioRoot, relativePath);

	const previous = getTurnByIdx(store.db, sessionId, turnIdx);
	const previousAudioPath = previous?.audioPath ?? null;

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, bytes);

	const stamped = setTurnAudioPath(store.db, sessionId, turnIdx, relativePath);
	if (!stamped) {
		await rm(absolutePath, { force: true });
		throw new AudioTurnNotFoundError(sessionId, turnIdx);
	}

	if (previousAudioPath !== null && previousAudioPath !== relativePath) {
		await rm(join(audioRoot, previousAudioPath), { force: true });
	}
	return relativePath;
}

/**
 * Read a turn's uploaded audio. Returns a `Bun.file().stream()` so the bytes
 * never land fully in heap. Throws `AudioTurnNotFoundError` (no row) or
 * `AudioNotUploadedError` (row but no audio, or file gone). Both map to 404.
 */
export async function readTurnAudio(
	store: Store,
	audioRoot: string,
	sessionId: string,
	turnIdx: number,
): Promise<AudioStream> {
	const turn = getTurnByIdx(store.db, sessionId, turnIdx);
	if (turn === undefined) {
		throw new AudioTurnNotFoundError(sessionId, turnIdx);
	}
	if (turn.audioPath === null) {
		throw new AudioNotUploadedError(sessionId, turnIdx);
	}
	const file = Bun.file(join(audioRoot, turn.audioPath));
	if (!(await file.exists())) {
		throw new AudioNotUploadedError(sessionId, turnIdx);
	}
	const extension = extensionFromPath(turn.audioPath);
	return {
		stream: file.stream(),
		contentLength: file.size,
		contentType: EXTENSION_TO_RESPONSE_CONTENT_TYPE[extension],
	};
}

function audioRelativePath(sessionId: string, turnIdx: number, ext: AudioExtension): string {
	return join(sessionId, `${turnIdx}.${ext}`);
}

function extensionFromPath(path: string): AudioExtension {
	// Parse, not cast: a manual write to audio_path could put anything there.
	return v.parse(AudioExtensionSchema, extname(path).slice(1));
}
