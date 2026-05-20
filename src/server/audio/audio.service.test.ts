import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";

import { replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
} from "./audio.errors.ts";
import { readReplayAudio, uploadReplayAudio } from "./audio.service.ts";
import { fakeAudioBytes, makeTempAudioRoot, seedReplayForAudio } from "./audio.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;

beforeEach(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
});

afterEach(() => {
	store.close();
	audio.dispose();
});

describe("uploadReplayAudio / readReplayAudio", () => {
	it("stores bytes under <audioRoot>/<replayId>/replay.<ext> and stamps audio_path", async () => {
		const { replayId } = seedReplayForAudio(store);
		const bytes = fakeAudioBytes(5);
		const rel = await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			bytes,
		});
		expect(rel).toBe(join(replayId, "replay.wav"));
		const result = await readReplayAudio(store, audio.path, replayId);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
		expect(result.contentType).toBe("audio/wav");
	});

	it("re-upload with different content-type deletes the old file", async () => {
		const { replayId } = seedReplayForAudio(store);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			bytes: fakeAudioBytes(1),
		});
		const second = fakeAudioBytes(2);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/opus",
			bytes: second,
		});
		const result = await readReplayAudio(store, audio.path, replayId);
		expect(await streamToBytes(result.stream)).toEqual(second);
		expect(result.contentType).toBe("audio/opus");
	});

	it("throws AudioNotUploadedError when no audio exists yet", async () => {
		const { replayId } = seedReplayForAudio(store);
		await expect(readReplayAudio(store, audio.path, replayId)).rejects.toBeInstanceOf(
			AudioNotUploadedError,
		);
	});

	it("throws AudioReplayNotFoundError when the replay is missing", async () => {
		await expect(
			readReplayAudio(store, audio.path, "00000000-0000-0000-0000-000000000099"),
		).rejects.toBeInstanceOf(AudioReplayNotFoundError);
	});

	it("upload throws AudioReplayNotFoundError when the replay is missing", async () => {
		await expect(
			uploadReplayAudio(store, audio.path, {
				replayId: "00000000-0000-0000-0000-000000000099",
				contentType: "audio/wav",
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(AudioReplayNotFoundError);
	});
});

describe("path-traversal defense", () => {
	it("readReplayAudio throws AudioPathOutsideRootError when a tampered row escapes the root", async () => {
		const { replayId } = seedReplayForAudio(store);
		store.db
			.update(replays)
			.set({ audioPath: "../escape/secret" })
			.where(eq(replays.id, replayId))
			.run();
		const err = await captureThrown(() => readReplayAudio(store, audio.path, replayId));
		expect(err).toBeInstanceOf(AudioPathOutsideRootError);
		if (!(err instanceof AudioPathOutsideRootError)) throw err;
		expect(err.audioRoot).toBe(resolve(audio.path));
		expect(err.attemptedPath.endsWith(join("escape", "secret"))).toBe(true);
		expect(err.attemptedPath.startsWith(`${resolve(audio.path)}/`)).toBe(false);
	});
});

async function captureThrown(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error("expected function to throw, but it resolved");
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(new ArrayBuffer(total));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
