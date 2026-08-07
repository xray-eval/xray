import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";

import { replays } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	AudioNotUploadedError,
	AudioPathOutsideRootError,
	AudioReplayNotFoundError,
	InvalidAudioExtensionError,
	ReplayUploadStateError,
} from "./audio.errors.ts";
import {
	conversationAudioRelativePath,
	readConversationTurnAudio,
	readReplayAudio,
	saveRecordedConversationAudio,
	saveTtsConversationAudio,
	uploadReplayAudio,
} from "./audio.service.ts";
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
		const { replayId } = await seedReplayForAudio(store);
		const bytes = fakeAudioBytes(5);
		const rel = await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			recordingStartedAt: null,
			bytes,
		});
		expect(rel).toBe(join(replayId, "replay.wav"));
		const result = await readReplayAudio(store, audio.path, replayId);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
		expect(result.contentType).toBe("audio/wav");
	});

	it("re-upload overwrites the previous wav bytes", async () => {
		const { replayId } = await seedReplayForAudio(store);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			recordingStartedAt: null,
			bytes: fakeAudioBytes(1),
		});
		const second = fakeAudioBytes(2);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			recordingStartedAt: null,
			bytes: second,
		});
		const result = await readReplayAudio(store, audio.path, replayId);
		expect(await streamToBytes(result.stream)).toEqual(second);
		expect(result.contentType).toBe("audio/wav");
	});

	it("throws AudioNotUploadedError when no audio exists yet", async () => {
		const { replayId } = await seedReplayForAudio(store);
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
				recordingStartedAt: null,
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(AudioReplayNotFoundError);
	});
});

describe("uploadReplayAudio — lifecycle guard", () => {
	it("allows upload in `running` state (driver retries before analysis)", async () => {
		const { replayId } = await seedReplayForAudio(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "running" })
			.where(eq(replays.id, replayId))
			.run();
		await expect(
			uploadReplayAudio(store, audio.path, {
				replayId,
				contentType: "audio/wav",
				recordingStartedAt: null,
				bytes: fakeAudioBytes(),
			}),
		).resolves.toBeString();
	});

	it("allows re-upload in `recording_uploaded` (overwrite before /analyze)", async () => {
		const { replayId } = await seedReplayForAudio(store);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			recordingStartedAt: null,
			bytes: fakeAudioBytes(1),
		});
		await expect(
			uploadReplayAudio(store, audio.path, {
				replayId,
				contentType: "audio/wav",
				recordingStartedAt: null,
				bytes: fakeAudioBytes(2),
			}),
		).resolves.toBeString();
	});

	it("rejects upload while `analyzing` (worker is running, would race)", async () => {
		const { replayId } = await seedReplayForAudio(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "analyzing", analysisStep: "vad", jobId: "j-1" })
			.where(eq(replays.id, replayId))
			.run();
		const err = await captureThrown(() =>
			uploadReplayAudio(store, audio.path, {
				replayId,
				contentType: "audio/wav",
				recordingStartedAt: null,
				bytes: fakeAudioBytes(),
			}),
		);
		expect(err).toBeInstanceOf(ReplayUploadStateError);
		if (!(err instanceof ReplayUploadStateError)) throw err;
		expect(err.replayId).toBe(replayId);
		expect(err.currentState).toBe("analyzing");
	});

	it("rejects upload from terminal `completed`", async () => {
		const { replayId } = await seedReplayForAudio(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "completed" })
			.where(eq(replays.id, replayId))
			.run();
		await expect(
			uploadReplayAudio(store, audio.path, {
				replayId,
				contentType: "audio/wav",
				recordingStartedAt: null,
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(ReplayUploadStateError);
	});

	it("rejects upload from terminal `failed`", async () => {
		const { replayId } = await seedReplayForAudio(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "failed", failureReason: "max_attempts_exceeded" })
			.where(eq(replays.id, replayId))
			.run();
		await expect(
			uploadReplayAudio(store, audio.path, {
				replayId,
				contentType: "audio/wav",
				recordingStartedAt: null,
				bytes: fakeAudioBytes(),
			}),
		).rejects.toBeInstanceOf(ReplayUploadStateError);
	});
});

describe("conversation turn audio", () => {
	const SHA_A = "a".repeat(64);
	const SHA_B = "b".repeat(64);

	it("keys recorded and synthesized audio into sibling directories by content hash", () => {
		expect(conversationAudioRelativePath("recorded", SHA_A)).toBe(join("recorded", `${SHA_A}.wav`));
		expect(conversationAudioRelativePath("tts", SHA_A)).toBe(join("tts", `${SHA_A}.wav`));
	});

	it("saves recorded bytes at the content-addressed path and reads them back as audio/wav", async () => {
		const bytes = fakeAudioBytes(3);
		const rel = await saveRecordedConversationAudio(audio.path, SHA_A, bytes);
		expect(rel).toBe(join("recorded", `${SHA_A}.wav`));
		const result = await readConversationTurnAudio(audio.path, "recorded", SHA_A, missingError);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
		expect(result.contentLength).toBe(bytes.byteLength);
		expect(result.contentType).toBe("audio/wav");
	});

	it("keeps the tts namespace disjoint from recorded for the same hash", async () => {
		// A RecordedAudio turn and a server-synthesized turn can hash the same
		// only by coincidence, but the two are different bytes with different
		// provenance — one must never serve the other's file.
		const recorded = fakeAudioBytes(1);
		const synthesized = fakeAudioBytes(2);
		await saveRecordedConversationAudio(audio.path, SHA_A, recorded);
		const rel = await saveTtsConversationAudio(audio.path, SHA_A, synthesized);
		expect(rel).toBe(join("tts", `${SHA_A}.wav`));
		const fromRecorded = await readConversationTurnAudio(
			audio.path,
			"recorded",
			SHA_A,
			missingError,
		);
		const fromTts = await readConversationTurnAudio(audio.path, "tts", SHA_A, missingError);
		expect(await streamToBytes(fromRecorded.stream)).toEqual(recorded);
		expect(await streamToBytes(fromTts.stream)).toEqual(synthesized);
	});

	it("re-saving the same hash leaves exactly one file — no orphaned .tmp- writes", async () => {
		const bytes = fakeAudioBytes(4);
		await saveRecordedConversationAudio(audio.path, SHA_A, bytes);
		await saveRecordedConversationAudio(audio.path, SHA_A, bytes);
		expect(await readdir(join(audio.path, "recorded"))).toEqual([`${SHA_A}.wav`]);
		const result = await readConversationTurnAudio(audio.path, "recorded", SHA_A, missingError);
		expect(await streamToBytes(result.stream)).toEqual(bytes);
	});

	it("throws the caller's error when the hash was never saved", async () => {
		await saveRecordedConversationAudio(audio.path, SHA_A, fakeAudioBytes());
		await expect(
			readConversationTurnAudio(audio.path, "recorded", SHA_B, missingError),
		).rejects.toBeInstanceOf(TurnAudioMissingError);
	});

	it("throws the caller's error when the hash exists only in the other namespace", async () => {
		await saveTtsConversationAudio(audio.path, SHA_A, fakeAudioBytes());
		await expect(
			readConversationTurnAudio(audio.path, "recorded", SHA_A, missingError),
		).rejects.toBeInstanceOf(TurnAudioMissingError);
	});

	it("rejects a hash that walks out of the audio root", async () => {
		// The server computes the hash, so this is unreachable today; the guard
		// is what keeps it unreachable if a hash ever becomes caller-supplied.
		await expect(
			saveRecordedConversationAudio(audio.path, "../../escape", fakeAudioBytes()),
		).rejects.toBeInstanceOf(AudioPathOutsideRootError);
	});
});

describe("stored audio_path extension", () => {
	it("readReplayAudio throws InvalidAudioExtensionError for a tampered non-audio extension", async () => {
		const { replayId } = await seedReplayForAudio(store);
		await uploadReplayAudio(store, audio.path, {
			replayId,
			contentType: "audio/wav",
			recordingStartedAt: null,
			bytes: fakeAudioBytes(),
		});
		// The extension check runs after the existence check, so the tampered
		// target has to exist on disk for this branch to be reached at all.
		const tampered = join(replayId, "replay.bin");
		await Bun.write(join(audio.path, tampered), fakeAudioBytes());
		store.db.update(replays).set({ audioPath: tampered }).where(eq(replays.id, replayId)).run();

		const err = await captureThrown(() => readReplayAudio(store, audio.path, replayId));
		expect(err).toBeInstanceOf(InvalidAudioExtensionError);
		if (!(err instanceof InvalidAudioExtensionError)) throw err;
		expect(err.relativePath).toBe(tampered);
		expect(err.issues.length).toBeGreaterThan(0);
	});
});

describe("path-traversal defense", () => {
	it("readReplayAudio throws AudioPathOutsideRootError when a tampered row escapes the root", async () => {
		const { replayId } = await seedReplayForAudio(store);
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

// `readConversationTurnAudio` takes the not-found error as a factory so the
// conversations router can throw its own 404 type. A local class proves the
// factory is what's thrown, not an audio-slice error.
class TurnAudioMissingError extends Error {
	constructor() {
		super("turn audio missing");
		this.name = "TurnAudioMissingError";
	}
}

function missingError(): Error {
	return new TurnAudioMissingError();
}

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
