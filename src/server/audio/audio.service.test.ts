import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { getTurnByIdx } from "@/server/store/turns-repo.ts";

import { AudioNotUploadedError, AudioTurnNotFoundError } from "./audio.errors.ts";
import { readTurnAudio, uploadTurnAudio } from "./audio.service.ts";
import { fakeAudioBytes, makeTempAudioRoot, seedSessionWithTurn } from "./audio.test-utils.ts";
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
	it("writes the bytes under <audioRoot>/<sessionId>/<idx>.<ext> and stamps audio_path", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const bytes = fakeAudioBytes();

		const relativePath = await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx,
			contentType: "audio/opus",
			bytes,
		});

		expect(relativePath).toBe(join(sessionId, `${turnIdx}.opus`));
		const onDisk = readFileSync(join(audio.path, relativePath));
		expect(new Uint8Array(onDisk)).toEqual(bytes);

		const turn = getTurnByIdx(store.db, sessionId, turnIdx);
		expect(turn?.audioPath).toBe(relativePath);
	});

	it("maps audio/mpeg to the .mp3 extension (alias collapses on the canonical name)", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const relativePath = await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx,
			contentType: "audio/mpeg",
			bytes: fakeAudioBytes(),
		});
		expect(relativePath.endsWith(".mp3")).toBe(true);
	});

	it("throws AudioTurnNotFoundError when the turn does not exist", async () => {
		seedSessionWithTurn(store, { sessionId: "sess-A", turnIdx: 0 });
		await expect(
			uploadTurnAudio(store, audio.path, {
				sessionId: "sess-A",
				turnIdx: 99,
				contentType: "audio/opus",
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(AudioTurnNotFoundError);
	});
});

describe("readTurnAudio", () => {
	it("returns the bytes and a canonical Content-Type after an upload", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const bytes = fakeAudioBytes(3);
		await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx,
			contentType: "audio/wav",
			bytes,
		});

		const result = await readTurnAudio(store, audio.path, sessionId, turnIdx);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
		expect(result.contentType).toBe("audio/wav");
		expect(result.contentLength).toBe(bytes.byteLength);
	});

	it("returns audio/mpeg for an mp3 read (canonical IANA name, not audio/mp3)", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx,
			contentType: "audio/mp3",
			bytes: fakeAudioBytes(),
		});
		const result = await readTurnAudio(store, audio.path, sessionId, turnIdx);
		expect(result.contentType).toBe("audio/mpeg");
	});

	it("throws AudioNotUploadedError when the turn exists but has no audio", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		await expect(readTurnAudio(store, audio.path, sessionId, turnIdx)).rejects.toBeInstanceOf(
			AudioNotUploadedError,
		);
	});

	it("throws AudioTurnNotFoundError when the turn does not exist", async () => {
		await expect(readTurnAudio(store, audio.path, "missing", 0)).rejects.toBeInstanceOf(
			AudioTurnNotFoundError,
		);
	});

	it("survives a re-upload of the same turn with a different extension and removes the old file", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx,
			contentType: "audio/opus",
			bytes: fakeAudioBytes(1),
		});
		const oldFile = join(audio.path, sessionId, `${turnIdx}.opus`);
		expect(existsSync(oldFile)).toBe(true);

		const second = fakeAudioBytes(2);
		await uploadTurnAudio(store, audio.path, {
			sessionId,
			turnIdx,
			contentType: "audio/wav",
			bytes: second,
		});
		const result = await readTurnAudio(store, audio.path, sessionId, turnIdx);
		expect(await streamToBytes(result.stream)).toEqual(second);
		expect(result.contentType).toBe("audio/wav");
		// Old extension's file must be gone — no orphans on extension change.
		expect(existsSync(oldFile)).toBe(false);
	});
});

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
