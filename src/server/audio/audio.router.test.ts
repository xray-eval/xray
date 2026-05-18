import * as v from "valibot";

import { createApp } from "@/server/server.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	audioUrl,
	fakeAudioBytes,
	makeTempAudioRoot,
	seedReplayWithTurn,
} from "./audio.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const UploadResponseBodySchema = v.object({
	ok: v.literal(true),
	audioPath: v.string(),
});

const NotFoundBodySchema = v.object({
	error: v.string(),
	replayId: v.optional(v.string()),
	turnIdx: v.optional(v.number()),
});

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
	app = createApp(store, { audioRoot: audio.path });
});

afterEach(() => {
	store.close();
	audio.dispose();
});

async function uploadTurn(
	replayId: string,
	turnIdx: number,
	bytes: Uint8Array<ArrayBuffer>,
	contentType = "audio/opus",
): Promise<Response> {
	return app.request(audioUrl(replayId, turnIdx), {
		method: "POST",
		headers: { "Content-Type": contentType },
		body: bytes,
	});
}

describe("POST /v1/replays/:id/turns/:idx/audio — happy path", () => {
	it("accepts an upload and returns the relative path", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const bytes = fakeAudioBytes();

		const res = await uploadTurn(replayId, turnIdx, bytes);
		expect(res.status).toBe(200);

		const body = v.parse(UploadResponseBodySchema, await res.json());
		expect(body.audioPath).toBe(`${replayId}/turns/${turnIdx}.opus`);
	});

	it("upload→retrieve roundtrip preserves bytes exactly", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const bytes = fakeAudioBytes(11);

		const uploadRes = await uploadTurn(replayId, turnIdx, bytes, "audio/webm");
		expect(uploadRes.status).toBe(200);

		const getRes = await app.request(audioUrl(replayId, turnIdx));
		expect(getRes.status).toBe(200);
		expect(getRes.headers.get("Content-Type")).toBe("audio/webm");

		const downloaded = new Uint8Array(await getRes.arrayBuffer());
		expect(downloaded).toEqual(bytes);
	});

	it("strips codec parameters from the Content-Type before lookup", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const res = await uploadTurn(replayId, turnIdx, fakeAudioBytes(), 'audio/webm; codecs="opus"');
		expect(res.status).toBe(200);
	});
});

describe("POST /v1/replays/:id/turns/:idx/audio — rejections", () => {
	it("rejects an unsupported content type with 415", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const res = await uploadTurn(replayId, turnIdx, fakeAudioBytes(), "application/octet-stream");
		expect(res.status).toBe(415);
	});

	it("rejects a missing content type with 415", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const res = await app.request(audioUrl(replayId, turnIdx), {
			method: "POST",
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(415);
	});

	it("rejects an unknown turn idx with 404", async () => {
		const { replayId } = seedReplayWithTurn(store);
		const res = await uploadTurn(replayId, 99, fakeAudioBytes());
		expect(res.status).toBe(404);
		const body = v.parse(NotFoundBodySchema, await res.json());
		expect(body.turnIdx).toBe(99);
	});

	it("rejects a non-uuid replay id with 400", async () => {
		const res = await app.request("http://test.local/v1/replays/not-a-uuid/turns/0/audio", {
			method: "POST",
			headers: { "Content-Type": "audio/opus" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a non-numeric turn idx with 400", async () => {
		const { replayId } = seedReplayWithTurn(store);
		const res = await app.request(`http://test.local/v1/replays/${replayId}/turns/abc/audio`, {
			method: "POST",
			headers: { "Content-Type": "audio/opus" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/replays/:id/turns/:idx/audio — rejections", () => {
	it("returns 404 for a turn that exists but has no upload", async () => {
		const { replayId, turnIdx } = seedReplayWithTurn(store);
		const res = await app.request(audioUrl(replayId, turnIdx));
		expect(res.status).toBe(404);
	});

	it("returns 404 for a replay that does not exist", async () => {
		const res = await app.request(audioUrl("00000000-0000-0000-0000-000000000099", 0));
		expect(res.status).toBe(404);
	});
});

describe("POST/GET /v1/replays/:id/audio — full-replay mixdown", () => {
	it("uploads and serves the full-replay mixdown", async () => {
		const { replayId } = seedReplayWithTurn(store);
		const bytes = fakeAudioBytes(7);
		const upRes = await app.request(audioUrl(replayId), {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: bytes,
		});
		expect(upRes.status).toBe(200);

		const getRes = await app.request(audioUrl(replayId));
		expect(getRes.status).toBe(200);
		const downloaded = new Uint8Array(await getRes.arrayBuffer());
		expect(downloaded).toEqual(bytes);
	});

	it("returns 404 if no mixdown has been uploaded", async () => {
		const { replayId } = seedReplayWithTurn(store);
		const res = await app.request(audioUrl(replayId));
		expect(res.status).toBe(404);
	});
});
