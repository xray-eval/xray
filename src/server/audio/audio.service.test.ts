import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { and, eq } from "drizzle-orm";

import { replays, replayTurns } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	AudioTurnNotFoundError,
} from "./audio.errors.ts";
import {
	readReplayAudio,
	readTurnAudio,
	uploadReplayAudio,
	uploadTurnAudio,
} from "./audio.service.ts";
import { fakeAudioBytes, makeTempAudioRoot, seedReplayWithTurn } from "./audio.test-utils.ts";
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

describe("uploadTurnAudio", () => {
	it("writes bytes under <audioRoot>/<replayId>/turns/<idx>.<ext> and stamps audio_path", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const bytes = fakeAudioBytes();

		const relativePath = await uploadTurnAudio(store, audio.path, {
			replayId,
			turnIdx,
			contentType: "audio/opus",
			bytes,
		});

		expect(relativePath).toBe(join(replayId, "turns", `${turnIdx}.opus`));
		const onDisk = readFileSync(join(audio.path, relativePath));
		expect(new Uint8Array(onDisk)).toEqual(bytes);

		const row = store.db
			.select()
			.from(replayTurns)
			.where(and(eq(replayTurns.replayId, replayId), eq(replayTurns.idx, turnIdx)))
			.get();
		expect(row?.audioPath).toBe(relativePath);
	});

	it("maps audio/mpeg to the .mp3 extension", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const rel = await uploadTurnAudio(store, audio.path, {
			replayId,
			turnIdx,
			contentType: "audio/mpeg",
			bytes: fakeAudioBytes(),
		});
		expect(rel.endsWith(".mp3")).toBe(true);
	});

	it("throws AudioReplayNotFoundError when the replay does not exist", async () => {
		await expect(
			uploadTurnAudio(store, audio.path, {
				replayId: "00000000-0000-0000-0000-000000000099",
				turnIdx: 0,
				contentType: "audio/opus",
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(AudioReplayNotFoundError);
	});

	it("throws AudioTurnNotFoundError when the turn does not exist", async () => {
		const { replayId } = seedReplayWithTurn(store);
		await expect(
			uploadTurnAudio(store, audio.path, {
				replayId,
				turnIdx: 99,
				contentType: "audio/opus",
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(AudioTurnNotFoundError);
	});
});

describe("readTurnAudio", () => {
	it("round-trips bytes and reports canonical Content-Type", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const bytes = fakeAudioBytes(3);
		await uploadTurnAudio(store, audio.path, {
			replayId,
			turnIdx,
			contentType: "audio/wav",
			bytes,
		});
		const result = await readTurnAudio(store, audio.path, replayId, turnIdx);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
		expect(result.contentType).toBe("audio/wav");
		expect(result.contentLength).toBe(bytes.byteLength);
	});

	it("returns audio/mpeg for an mp3 read", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		await uploadTurnAudio(store, audio.path, {
			replayId,
			turnIdx,
			contentType: "audio/mp3",
			bytes: fakeAudioBytes(),
		});
		const result = await readTurnAudio(store, audio.path, replayId, turnIdx);
		expect(result.contentType).toBe("audio/mpeg");
	});

	it("throws AudioNotUploadedError when no audio exists yet", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		await expect(readTurnAudio(store, audio.path, replayId, turnIdx)).rejects.toBeInstanceOf(
			AudioNotUploadedError,
		);
	});

	it("throws AudioTurnNotFoundError for an unknown turn", async () => {
		const { replayId } = seedReplayWithTurn(store);
		await expect(readTurnAudio(store, audio.path, replayId, 99)).rejects.toBeInstanceOf(
			AudioTurnNotFoundError,
		);
	});

	it("re-upload with different extension deletes the old file", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		await uploadTurnAudio(store, audio.path, {
			replayId,
			turnIdx,
			contentType: "audio/opus",
			bytes: fakeAudioBytes(1),
		});
		const oldFile = join(audio.path, replayId, "turns", `${turnIdx}.opus`);
		expect(existsSync(oldFile)).toBe(true);

		const second = fakeAudioBytes(2);
		await uploadTurnAudio(store, audio.path, {
			replayId,
			turnIdx,
			contentType: "audio/wav",
			bytes: second,
		});
		const result = await readTurnAudio(store, audio.path, replayId, turnIdx);
		expect(await streamToBytes(result.stream)).toEqual(second);
		expect(result.contentType).toBe("audio/wav");
		expect(existsSync(oldFile)).toBe(false);
	});
});

describe("uploadReplayAudio / readReplayAudio", () => {
	it("stores and serves the full-replay mixdown", async () => {
		const { replayId } = seedReplayWithTurn(store);
		const bytes = fakeAudioBytes(5);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			bytes,
		});
		const result = await readReplayAudio(store, audio.path, replayId);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
		expect(result.contentType).toBe("audio/wav");
	});

	it("throws AudioNotUploadedError when no full-replay mixdown exists", async () => {
		const { replayId } = seedReplayWithTurn(store);
		await expect(readReplayAudio(store, audio.path, replayId)).rejects.toBeInstanceOf(
			AudioNotUploadedError,
		);
	});

	it("throws AudioReplayNotFoundError when the replay is missing", async () => {
		await expect(
			readReplayAudio(store, audio.path, "00000000-0000-0000-0000-000000000099"),
		).rejects.toBeInstanceOf(AudioReplayNotFoundError);
	});
});

describe("path-traversal defense", () => {
	it("readReplayAudio throws AudioPathOutsideRootError when a tampered row escapes the root", async () => {
		const { replayId } = seedReplayWithTurn(store);
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

	it("readTurnAudio throws AudioPathOutsideRootError when a tampered turn row escapes the root", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		store.db
			.update(replayTurns)
			.set({ audioPath: "../escape/turn-secret" })
			.where(and(eq(replayTurns.replayId, replayId), eq(replayTurns.idx, turnIdx)))
			.run();
		const err = await captureThrown(() => readTurnAudio(store, audio.path, replayId, turnIdx));
		expect(err).toBeInstanceOf(AudioPathOutsideRootError);
		if (!(err instanceof AudioPathOutsideRootError)) throw err;
		expect(err.audioRoot).toBe(resolve(audio.path));
		expect(err.attemptedPath.endsWith(join("escape", "turn-secret"))).toBe(true);
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
