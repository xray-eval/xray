import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { findReplay } from "@/server/replays/replays.service.ts";
import { replays, replayTurns } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import {
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	AudioTurnNotFoundError,
} from "./audio.errors.ts";
import type { AudioContentType, AudioExtension, AudioStream } from "./audio.types.ts";
import {
	AudioExtensionSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
} from "./audio.types.ts";

/**
 * Upload a per-turn audio file. Writes the file then UPDATEs
 * `replay_turns.audio_path` guarded on the turn's existence; on re-upload
 * with a different extension the previous file is removed.
 *
 * Paths are always derived server-side from `audioRoot` + replayId + idx.
 * No path component ever comes from a request body — traversal is
 * impossible by construction, and the read path's prefix check (below) is
 * a defense-in-depth backstop against tampered DB rows.
 */
export async function uploadTurnAudio(
	store: Store,
	audioRoot: string,
	params: {
		replayId: string;
		turnIdx: number;
		contentType: AudioContentType;
		bytes: Uint8Array<ArrayBuffer>;
	},
): Promise<string> {
	const { replayId, turnIdx, contentType, bytes } = params;
	if (findReplay(store, replayId) === undefined) {
		throw new AudioReplayNotFoundError(replayId);
	}
	const turn = getReplayTurn(store, replayId, turnIdx);
	if (turn === undefined) throw new AudioTurnNotFoundError(replayId, turnIdx);

	const extension = CONTENT_TYPE_TO_EXTENSION[contentType];
	const relativePath = turnRelativePath(replayId, turnIdx, extension);
	const absolutePath = resolveInsideRoot(audioRoot, relativePath);
	const previousAudioPath = turn.audioPath ?? null;

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, bytes);

	store.db
		.update(replayTurns)
		.set({ audioPath: relativePath })
		.where(and(eq(replayTurns.replayId, replayId), eq(replayTurns.idx, turnIdx)))
		.run();

	if (previousAudioPath !== null && previousAudioPath !== relativePath) {
		await rm(resolveInsideRoot(audioRoot, previousAudioPath), { force: true });
	}
	return relativePath;
}

/** Upload the full-replay mixdown. */
export async function uploadReplayAudio(
	store: Store,
	audioRoot: string,
	params: { replayId: string; contentType: AudioContentType; bytes: Uint8Array<ArrayBuffer> },
): Promise<string> {
	const { replayId, contentType, bytes } = params;
	if (findReplay(store, replayId) === undefined) {
		throw new AudioReplayNotFoundError(replayId);
	}
	const extension = CONTENT_TYPE_TO_EXTENSION[contentType];
	const relativePath = replayRelativePath(replayId, extension);
	const absolutePath = resolveInsideRoot(audioRoot, relativePath);

	const previous = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
	const previousAudioPath = previous?.audioPath ?? null;

	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, bytes);

	store.db.update(replays).set({ audioPath: relativePath }).where(eq(replays.id, replayId)).run();

	if (previousAudioPath !== null && previousAudioPath !== relativePath) {
		await rm(resolveInsideRoot(audioRoot, previousAudioPath), { force: true });
	}
	return relativePath;
}

export async function readTurnAudio(
	store: Store,
	audioRoot: string,
	replayId: string,
	turnIdx: number,
): Promise<AudioStream> {
	const turn = getReplayTurn(store, replayId, turnIdx);
	if (turn === undefined) throw new AudioTurnNotFoundError(replayId, turnIdx);
	if (turn.audioPath === null) throw new AudioNotUploadedError(replayId, turnIdx);
	return readAtRelativePath(
		audioRoot,
		turn.audioPath,
		() => new AudioNotUploadedError(replayId, turnIdx),
	);
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

function getReplayTurn(
	store: Store,
	replayId: string,
	turnIdx: number,
): { audioPath: string | null } | undefined {
	const row = store.db
		.select({ audioPath: replayTurns.audioPath })
		.from(replayTurns)
		.where(and(eq(replayTurns.replayId, replayId), eq(replayTurns.idx, turnIdx)))
		.get();
	return row ?? undefined;
}

function turnRelativePath(replayId: string, turnIdx: number, ext: AudioExtension): string {
	return join(replayId, "turns", `${turnIdx}.${ext}`);
}

function replayRelativePath(replayId: string, ext: AudioExtension): string {
	return join(replayId, `replay.${ext}`);
}

/**
 * Resolve `relativePath` under `audioRoot` and assert the result still
 * lives under `audioRoot`. Defense in depth against:
 *   - a tampered `audio_path` DB row pointing outside the volume
 *   - a future code change that accidentally joins user input
 *   - symlink shenanigans under the volume's tree
 */
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
	return v.parse(AudioExtensionSchema, extname(path).slice(1));
}
