import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";

import { eq } from "drizzle-orm";
import * as v from "valibot";

import { findReplay } from "@/server/replays/replays.service.ts";
import { replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import {
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
} from "./audio.errors.ts";
import type { AudioContentType, AudioExtension, AudioStream } from "./audio.types.ts";
import {
	AudioExtensionSchema,
	CONTENT_TYPE_TO_EXTENSION,
	EXTENSION_TO_RESPONSE_CONTENT_TYPE,
} from "./audio.types.ts";

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
	return v.parse(AudioExtensionSchema, extname(path).slice(1));
}
