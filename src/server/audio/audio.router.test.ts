import * as v from "valibot";

import { createApp } from "@/server/server.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	audioUrl,
	fakeAudioBytes,
	makeTempAudioRoot,
	seedSessionWithTurn,
} from "./audio.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const UploadResponseBodySchema = v.object({
	ok: v.literal(true),
	audioPath: v.string(),
});

const NotFoundBodySchema = v.object({
	error: v.literal("audio_not_found"),
	sessionId: v.string(),
	turnIdx: v.number(),
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

async function upload(
	sessionId: string,
	turnIdx: number,
	bytes: Uint8Array<ArrayBuffer>,
	contentType = "audio/opus",
): Promise<Response> {
	return app.request(audioUrl(sessionId, turnIdx), {
		method: "POST",
		headers: { "Content-Type": contentType },
		body: bytes,
	});
}

describe("POST /v1/sessions/:id/turns/:idx/audio — happy path", () => {
	it("accepts an upload, stamps audio_path, and returns the relative path", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const bytes = fakeAudioBytes();

		const res = await upload(sessionId, turnIdx, bytes);
		expect(res.status).toBe(200);

		const body = v.parse(UploadResponseBodySchema, await res.json());
		expect(body.audioPath).toBe(`${sessionId}/${turnIdx}.opus`);
	});

	it("upload→retrieve roundtrip preserves bytes exactly", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const bytes = fakeAudioBytes(11);

		const uploadRes = await upload(sessionId, turnIdx, bytes, "audio/webm");
		expect(uploadRes.status).toBe(200);

		const getRes = await app.request(audioUrl(sessionId, turnIdx));
		expect(getRes.status).toBe(200);
		expect(getRes.headers.get("Content-Type")).toBe("audio/webm");

		const downloaded = new Uint8Array(await getRes.arrayBuffer());
		expect(downloaded).toEqual(bytes);
	});

	it("strips codec parameters from the Content-Type before lookup", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const res = await upload(sessionId, turnIdx, fakeAudioBytes(), 'audio/webm; codecs="opus"');
		expect(res.status).toBe(200);
	});
});

describe("POST /v1/sessions/:id/turns/:idx/audio — rejections", () => {
	it("rejects an unsupported content type with 415", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const res = await upload(sessionId, turnIdx, fakeAudioBytes(), "application/octet-stream");
		expect(res.status).toBe(415);
	});

	it("rejects a missing content type with 415", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const res = await app.request(audioUrl(sessionId, turnIdx), {
			method: "POST",
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(415);
	});

	it("rejects an unknown turn idx with 404", async () => {
		seedSessionWithTurn(store, { sessionId: "sess-A", turnIdx: 0 });
		const res = await upload("sess-A", 99, fakeAudioBytes());
		expect(res.status).toBe(404);
		const body = v.parse(NotFoundBodySchema, await res.json());
		expect(body.turnIdx).toBe(99);
	});

	it("rejects a malformed session id with 400", async () => {
		const res = await app.request("http://test.local/v1/sessions/has%20space/turns/0/audio", {
			method: "POST",
			headers: { "Content-Type": "audio/opus" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a non-numeric turn idx with 400", async () => {
		const { sessionId } = seedSessionWithTurn(store);
		const res = await app.request(`http://test.local/v1/sessions/${sessionId}/turns/abc/audio`, {
			method: "POST",
			headers: { "Content-Type": "audio/opus" },
			body: fakeAudioBytes(),
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /v1/sessions/:id/turns/:idx/audio — rejections", () => {
	it("returns 404 for a turn that exists but has no upload", async () => {
		const { sessionId, turnIdx } = seedSessionWithTurn(store);
		const res = await app.request(audioUrl(sessionId, turnIdx));
		expect(res.status).toBe(404);
		const body = v.parse(NotFoundBodySchema, await res.json());
		expect(body.sessionId).toBe(sessionId);
		expect(body.turnIdx).toBe(turnIdx);
	});

	it("returns 404 for a session that does not exist", async () => {
		const res = await app.request(audioUrl("missing", 0));
		expect(res.status).toBe(404);
	});
});
