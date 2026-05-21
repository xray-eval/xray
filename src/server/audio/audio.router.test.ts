import * as v from "valibot";

import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { createApp } from "@/server/server.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	fakeAudioBytes,
	makeTempAudioRoot,
	replayAudioUrl,
	seedReplayForAudio,
} from "./audio.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const UploadResponseBodySchema = v.object({
	ok: v.literal(true),
	audio_path: v.string(),
});

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
	app = createApp(store, {
		audioRoot: audio.path,
		jobRunner: makeFakeJobRunner(),
		events: makeReplayEvents(),
	});
});

afterEach(() => {
	store.close();
	audio.dispose();
});

describe("POST /v1/replays/:id/audio — happy path", () => {
	it("accepts an upload and returns the relative path", async () => {
		const { replayId } = seedReplayForAudio(store);
		const bytes = fakeAudioBytes();
		const res = await app.request(replayAudioUrl(replayId), {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: bytes,
		});
		expect(res.status).toBe(200);
		const body = v.parse(UploadResponseBodySchema, await res.json());
		expect(body.audio_path).toBe(`${replayId}/replay.wav`);
	});

	it("upload→retrieve roundtrip preserves bytes exactly", async () => {
		const { replayId } = seedReplayForAudio(store);
		const bytes = fakeAudioBytes(11);
		const upRes = await app.request(replayAudioUrl(replayId), {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: bytes,
		});
		expect(upRes.status).toBe(200);
		const getRes = await app.request(replayAudioUrl(replayId));
		expect(getRes.status).toBe(200);
		expect(getRes.headers.get("Content-Type")).toBe("audio/wav");
		const downloaded = new Uint8Array(await getRes.arrayBuffer());
		expect(downloaded).toEqual(bytes);
	});
});

describe("POST /v1/replays/:id/audio — rejections", () => {
	it("rejects an unsupported content type with 415", async () => {
		const { replayId } = seedReplayForAudio(store);
		const res = await app.request(replayAudioUrl(replayId), {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(415);
	});

	it("rejects a missing content type with 415", async () => {
		const { replayId } = seedReplayForAudio(store);
		const res = await app.request(replayAudioUrl(replayId), {
			method: "POST",
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(415);
	});

	it("rejects a non-uuid replay id with 400", async () => {
		const res = await app.request("http://test.local/v1/replays/not-a-uuid/audio", {
			method: "POST",
			headers: { "Content-Type": "audio/opus" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(400);
	});

	it("returns 404 when uploading to a non-existent replay", async () => {
		const res = await app.request(
			"http://test.local/v1/replays/00000000-0000-0000-0000-000000000099/audio",
			{
				method: "POST",
				headers: { "Content-Type": "audio/wav" },
				body: fakeAudioBytes(),
			},
		);
		expect(res.status).toBe(404);
	});
});

describe("POST /v1/replays/:id/audio — lifecycle 409", () => {
	it("returns 409 when the replay is `analyzing`", async () => {
		const { replayId } = seedReplayForAudio(store);
		const { replays } = await import("@/server/store/schema.ts");
		const { eq } = await import("drizzle-orm");
		store.db
			.update(replays)
			.set({ lifecycleState: "analyzing", analysisStep: "vad", jobId: "j-1" })
			.where(eq(replays.id, replayId))
			.run();
		const res = await app.request(replayAudioUrl(replayId), {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(409);
	});

	it("returns 409 when the replay is `completed`", async () => {
		const { replayId } = seedReplayForAudio(store);
		const { replays } = await import("@/server/store/schema.ts");
		const { eq } = await import("drizzle-orm");
		store.db
			.update(replays)
			.set({ lifecycleState: "completed" })
			.where(eq(replays.id, replayId))
			.run();
		const res = await app.request(replayAudioUrl(replayId), {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(409);
	});
});

describe("GET /v1/replays/:id/audio — rejections", () => {
	it("returns 404 for a replay with no upload yet", async () => {
		const { replayId } = seedReplayForAudio(store);
		const res = await app.request(replayAudioUrl(replayId));
		expect(res.status).toBe(404);
	});

	it("returns 404 for a replay that does not exist", async () => {
		const res = await app.request(
			"http://test.local/v1/replays/00000000-0000-0000-0000-000000000099/audio",
		);
		expect(res.status).toBe(404);
	});
});
