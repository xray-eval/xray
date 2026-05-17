import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import * as v from "valibot";

import type { Store } from "@/server/store/store.ts";
import { getTurnByIdx, setTurnAudioPath } from "@/server/store/turns-repo.ts";

import { AudioNotUploadedError, AudioTurnNotFoundError } from "./audio.errors.ts";
import type { AudioContentType, AudioExtension } from "./audio.types.ts";
import {
	AudioExtensionSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
} from "./audio.types.ts";

/**
 * Upload a turn's audio. Writes the bytes to
 * `<audioRoot>/<sessionId>/<turnIdx>.<ext>` then stamps the relative path
 * on `turns.audio_path` in a single UPDATE that's guarded on the turn's
 * existence — if the row vanished between writes, the file is removed and
 * `AudioTurnNotFoundError` propagates. Idempotent on the (sessionId, turnIdx)
 * pair: re-uploading overwrites the file and updates the column.
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
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, bytes);

	const stamped = setTurnAudioPath(store.db, sessionId, turnIdx, relativePath);
	if (!stamped) {
		// The turn was deleted between our write and our DB update (or never
		// existed). Remove the orphan file so the on-disk footprint matches.
		await rm(absolutePath, { force: true });
		throw new AudioTurnNotFoundError(sessionId, turnIdx);
	}
	return relativePath;
}

export interface AudioStream {
	readonly stream: ReadableStream<Uint8Array>;
	readonly contentLength: number;
	readonly contentType: string;
}

/**
 * Read a turn's uploaded audio as a streaming response. Throws
 * `AudioTurnNotFoundError` when no turn row matches, `AudioNotUploadedError`
 * when the turn exists but has no audio (or the file is missing). Both map
 * to 404; the distinction lives in logs. Bun streams the file off disk a
 * chunk at a time so a 50MB upload never lands fully in the process heap.
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

/**
 * Remove all uploaded audio for a session. Called from any session-delete
 * pathway so the on-disk footprint matches the DB (turns cascade-delete
 * already, but the file system is outside the SQLite transaction).
 *
 * `recursive: true, force: true` — a missing dir is success, not an error.
 * Sessions without uploaded audio never created the directory.
 */
export async function deleteSessionAudio(audioRoot: string, sessionId: string): Promise<void> {
	const dir = join(audioRoot, sessionId);
	await rm(dir, { recursive: true, force: true });
}

function audioRelativePath(sessionId: string, turnIdx: number, ext: AudioExtension): string {
	return join(sessionId, `${turnIdx}.${ext}`);
}

function extensionFromPath(path: string): AudioExtension {
	// Parse, not cast: a manual write to audio_path could put anything there.
	return v.parse(AudioExtensionSchema, extname(path).slice(1));
}
