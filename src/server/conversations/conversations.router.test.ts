import { Hono } from "hono";
import * as v from "valibot";

import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { readJson } from "@/server/core/test-utils.ts";
import {
	createReplayForTest,
	makeCreateReplayRequest,
} from "@/server/replays/replays.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createConversationsRouter } from "./conversations.router.ts";
import { MAX_CONVERSATION_BODY_BYTES } from "./conversations.types.ts";
import { afterEach, describe, expect, it } from "bun:test";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function makeApp() {
	const store = makeTempStore();
	const { path: audioRoot, dispose } = makeTempAudioRoot();
	cleanups.push(dispose);
	cleanups.push(() => {
		store.close();
	});
	const app = new Hono().route("/v1", createConversationsRouter(store, audioRoot));
	return { app, store, audioRoot, dispose };
}

async function postConversation(app: Hono, form: FormData): Promise<Response> {
	return app.request("/v1/conversations", { method: "POST", body: form });
}

function specForm(spec: unknown): FormData {
	const form = new FormData();
	form.set("spec", JSON.stringify(spec));
	return form;
}

describe("GET /v1/conversations", () => {
	it("returns one row per content hash", async () => {
		const { app, store } = makeApp();
		await createReplayForTest(
			store,
			makeCreateReplayRequest({
				name: "alpha",
				turns: [
					{ role: "user", text: "hi", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		await createReplayForTest(
			store,
			makeCreateReplayRequest({
				name: "beta",
				turns: [
					{ role: "user", text: "bye", key: "u0" },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const res = await app.request("/v1/conversations");
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({
				items: v.array(v.object({ hash: v.string(), name: v.string(), replays: v.number() })),
			}),
		);
		expect(body.items).toHaveLength(2);
		expect(body.items.every((i) => i.replays === 1)).toBe(true);
		expect(body.items.map((i) => i.name).sort()).toEqual(["alpha", "beta"]);
	});
});

describe("GET /v1/conversations/:hash", () => {
	it("returns the conversation row", async () => {
		const { app, store } = makeApp();
		const detail = await createReplayForTest(store, makeCreateReplayRequest({ name: "x" }));
		const hash = detail.conversation_hash;
		const res = await app.request(`/v1/conversations/${hash}`);
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ hash: v.string(), name: v.string() }));
		expect(body.hash).toBe(hash);
		expect(body.name).toBe("x");
	});

	it("returns 404 for unknown hash", async () => {
		const { app } = makeApp();
		const res = await app.request(`/v1/conversations/${"f".repeat(64)}`);
		expect(res.status).toBe(404);
	});

	it("returns 400 for a malformed hash", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/conversations/not-a-hash");
		expect(res.status).toBe(400);
	});
});

describe("POST /v1/conversations", () => {
	it("returns 200 + a stable hash for a text-only spec", async () => {
		const { app } = makeApp();
		const spec = {
			name: "n",
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		};
		const res = await postConversation(app, specForm(spec));
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({ hash: v.string(), name: v.string(), turns: v.array(v.unknown()) }),
		);
		expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(body.name).toBe("n");
		expect(body.turns).toHaveLength(2);
	});

	it("is idempotent — same content yields the same hash", async () => {
		const { app } = makeApp();
		const spec = {
			name: "n",
			turns: [{ role: "user", text: "same", key: "u0" }],
		};
		const r1 = await postConversation(app, specForm(spec));
		const r2 = await postConversation(app, specForm(spec));
		const b1 = await readJson(r1, v.object({ hash: v.string() }));
		const b2 = await readJson(r2, v.object({ hash: v.string() }));
		expect(b1.hash).toBe(b2.hash);
	});

	it("hashes recorded audio bytes into the conversation hash", async () => {
		const { app } = makeApp();
		const spec = {
			name: "with-audio",
			turns: [
				{
					role: "user",
					key: "u0",
					audio: { kind: "recorded", upload_key: "u0_wav" },
				},
				{ role: "agent", key: "a0" },
			],
		};
		const form = specForm(spec);
		form.set("u0_wav", new File([new Uint8Array([1, 2, 3, 4])], "u0.wav"));
		const res = await postConversation(app, form);
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ hash: v.string(), turns: v.array(v.unknown()) }));
		expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("returns 400 when the `spec` part is missing", async () => {
		const { app } = makeApp();
		const form = new FormData();
		form.set("u0_wav", new File([new Uint8Array([1])], "x.wav"));
		const res = await postConversation(app, form);
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_conversation_request");
	});

	it("returns 400 when `spec` is not valid JSON", async () => {
		const { app } = makeApp();
		const form = new FormData();
		form.set("spec", "{not-json");
		const res = await postConversation(app, form);
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_conversation_request");
	});

	it("returns 400 when the spec fails schema validation (empty turns)", async () => {
		const { app } = makeApp();
		const res = await postConversation(app, specForm({ name: "n", turns: [] }));
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_conversation_request");
	});

	it("returns 400 when a turn references an upload_key with no file part", async () => {
		const { app } = makeApp();
		const spec = {
			name: "n",
			turns: [
				{
					role: "user",
					key: "u0",
					audio: { kind: "recorded", upload_key: "missing_key" },
				},
				{ role: "agent", key: "a0" },
			],
		};
		const res = await postConversation(app, specForm(spec));
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string(), upload_key: v.string() }));
		expect(body.error).toBe("recorded_audio_upload_key_missing");
		expect(body.upload_key).toBe("missing_key");
	});

	it("returns 400 when an uploaded audio part is not referenced by any turn", async () => {
		const { app } = makeApp();
		const spec = {
			name: "n",
			turns: [
				{ role: "user", text: "hi", key: "u0" },
				{ role: "agent", key: "a0" },
			],
		};
		const form = specForm(spec);
		form.set("orphan", new File([new Uint8Array([1, 2])], "o.wav"));
		const res = await postConversation(app, form);
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string(), upload_key: v.string() }));
		expect(body.error).toBe("recorded_audio_upload_key_unreferenced");
		expect(body.upload_key).toBe("orphan");
	});

	it("returns 413 when the spec JSON exceeds MAX_CONVERSATION_BODY_BYTES", async () => {
		const { app } = makeApp();
		const oversize = "x".repeat(MAX_CONVERSATION_BODY_BYTES + 10);
		const spec = {
			name: "n",
			turns: [
				{ role: "user", text: oversize, key: "u0" },
				{ role: "agent", key: "a0" },
			],
		};
		const res = await postConversation(app, specForm(spec));
		expect(res.status).toBe(413);
		const body = await readJson(res, v.object({ error: v.string(), max_bytes: v.number() }));
		expect(body.error).toBe("body_too_large");
		expect(body.max_bytes).toBe(MAX_CONVERSATION_BODY_BYTES);
	});

	it("counts spec bytes via UTF-8 byte length, not UTF-16 code units", async () => {
		const { app } = makeApp();
		// "🎉" is 4 bytes UTF-8 / 2 code units UTF-16. Pick N emojis such that
		// the JSON's UTF-16 .length stays under MAX but its UTF-8 byteLength
		// exceeds MAX: MAX/4 < N < MAX/2.
		const emojiCount = Math.ceil(MAX_CONVERSATION_BODY_BYTES / 3);
		const heavyText = "🎉".repeat(emojiCount);
		const spec = {
			name: "n",
			turns: [
				{ role: "user", text: heavyText, key: "u0" },
				{ role: "agent", key: "a0" },
			],
		};
		const json = JSON.stringify(spec);
		// Sanity-check the construction so a future refactor of the constants
		// doesn't silently turn this into a 400 test.
		expect(json.length).toBeLessThan(MAX_CONVERSATION_BODY_BYTES);
		expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(MAX_CONVERSATION_BODY_BYTES);
		const res = await postConversation(app, specForm(spec));
		expect(res.status).toBe(413);
	});
});

describe("GET /v1/conversations/:hash/replays", () => {
	it("returns replays attached to the hash", async () => {
		const { app, store } = makeApp();
		const turns = [
			{ role: "user" as const, text: "hi", key: "u0" },
			{ role: "agent" as const, key: "a0" },
		];
		const first = await createReplayForTest(store, makeCreateReplayRequest({ name: "n", turns }));
		await createReplayForTest(store, makeCreateReplayRequest({ name: "n", turns }));
		const res = await app.request(`/v1/conversations/${first.conversation_hash}/replays`);
		expect(res.status).toBe(200);
		const body = await readJson(res, v.object({ items: v.array(v.unknown()) }));
		expect(body.items).toHaveLength(2);
	});

	it("returns 404 for unknown hash", async () => {
		const { app } = makeApp();
		const res = await app.request(`/v1/conversations/${"e".repeat(64)}/replays`);
		expect(res.status).toBe(404);
	});
});
