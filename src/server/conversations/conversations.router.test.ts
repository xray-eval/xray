import { Hono } from "hono";
import * as v from "valibot";

import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { readJson } from "@/server/core/test-utils.ts";
import {
	createReplayForTest,
	makeCreateReplayRequest,
} from "@/server/replays/replays.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";
import { TtsProviderError } from "@/server/tts/tts.errors.ts";
import { makeFakeTtsProvider } from "@/server/tts/tts.test-utils.ts";

import { createConversationsRouter } from "./conversations.router.ts";
import { MAX_CONVERSATION_BODY_BYTES } from "./conversations.types.ts";
import { afterEach, describe, expect, it } from "bun:test";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function makeApp(tts?: Parameters<typeof createConversationsRouter>[2]) {
	const store = makeTempStore();
	const { path: audioRoot, dispose } = makeTempAudioRoot();
	cleanups.push(dispose);
	cleanups.push(() => {
		store.close();
	});
	const ttsProvider = makeFakeTtsProvider();
	const app = new Hono().route(
		"/v1",
		createConversationsRouter(store, audioRoot, tts ?? { provider: ttsProvider }),
	);
	return { app, store, audioRoot, ttsProvider, dispose };
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
					{ role: "user", text: "hi", key: "u0", assertions: [] },
					{ role: "agent", key: "a0", assertions: [] },
				],
			}),
		);
		await createReplayForTest(
			store,
			makeCreateReplayRequest({
				name: "beta",
				turns: [
					{ role: "user", text: "bye", key: "u0", assertions: [] },
					{ role: "agent", key: "a0", assertions: [] },
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

	it("accepts empty turns when live=true and reports live in the response", async () => {
		const { app } = makeApp();
		const res = await postConversation(
			app,
			specForm({ name: "live-session", turns: [], live: true }),
		);
		expect(res.status).toBe(200);
		const body = await readJson(
			res,
			v.object({ hash: v.string(), live: v.boolean(), turns: v.array(v.unknown()) }),
		);
		expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(body.live).toBe(true);
		expect(body.turns).toHaveLength(0);
	});

	it("mints a fresh hash for every live POST (salted), unlike scripted upserts", async () => {
		const { app } = makeApp();
		const form = () => specForm({ name: "live-session", turns: [], live: true });
		const r1 = await postConversation(app, form());
		const r2 = await postConversation(app, form());
		const b1 = await readJson(r1, v.object({ hash: v.string() }));
		const b2 = await readJson(r2, v.object({ hash: v.string() }));
		expect(b1.hash).not.toBe(b2.hash);
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
			{ role: "user" as const, text: "hi", key: "u0", assertions: [] },
			{ role: "agent" as const, key: "a0", assertions: [] },
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

describe("POST /v1/conversations — tts synthesis", () => {
	const TtsTurnAudioSchema = v.object({
		kind: v.literal("tts"),
		sha256: v.string(),
		voice_id: v.optional(v.string()),
	});
	const TtsResponseSchema = v.object({
		hash: v.string(),
		turns: v.array(v.object({ audio: v.optional(v.unknown()) })),
	});

	function ttsSpec(text = "hello there") {
		return {
			name: "tts-conv",
			turns: [
				{ role: "user", text, audio: { kind: "tts", voice_id: "nova" } },
				{ role: "agent", key: "a0" },
			],
		};
	}

	it("synthesizes the turn and returns a canonical tts ref carrying the audio sha", async () => {
		const { app, ttsProvider } = makeApp();
		const res = await postConversation(app, specForm(ttsSpec()));
		expect(res.status).toBe(200);
		const body = await readJson(res, TtsResponseSchema);
		const audio = v.parse(TtsTurnAudioSchema, body.turns[0]?.audio);
		expect(audio.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(audio.voice_id).toBe("nova");
		expect(ttsProvider.calls).toEqual([{ text: "hello there", voice: "nova" }]);
	});

	it("reuses the synth cache on a re-POST: same hash, no second provider call", async () => {
		const { app, ttsProvider } = makeApp();
		const first = await postConversation(app, specForm(ttsSpec()));
		const second = await postConversation(app, specForm(ttsSpec()));
		const firstBody = await readJson(first, TtsResponseSchema);
		const secondBody = await readJson(second, TtsResponseSchema);
		expect(secondBody.hash).toBe(firstBody.hash);
		expect(ttsProvider.calls).toHaveLength(1);
	});

	it("returns 400 tts_turn_missing_text when a tts turn has no text", async () => {
		const { app } = makeApp();
		const spec = {
			name: "n",
			turns: [
				{ role: "user", audio: { kind: "tts" } },
				{ role: "agent", key: "a0" },
			],
		};
		const res = await postConversation(app, specForm(spec));
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string(), turn_idx: v.number() }));
		expect(body.error).toBe("tts_turn_missing_text");
		expect(body.turn_idx).toBe(0);
	});

	it("returns 400 tts_turn_invalid_role for a tts ref on an agent turn", async () => {
		const { app } = makeApp();
		const spec = {
			name: "n",
			turns: [
				{ role: "user", text: "hi" },
				{ role: "agent", audio: { kind: "tts" } },
			],
		};
		const res = await postConversation(app, specForm(spec));
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string(), turn_idx: v.number() }));
		expect(body.error).toBe("tts_turn_invalid_role");
		expect(body.turn_idx).toBe(1);
	});

	it("returns 503 tts_provider_unconfigured when the provider has no credential", async () => {
		const provider = makeFakeTtsProvider({
			error: new MissingProviderCredentialError("MISTRAL_API_KEY"),
		});
		const { app } = makeApp({ provider });
		const res = await postConversation(app, specForm(ttsSpec()));
		expect(res.status).toBe(503);
		const body = await readJson(res, v.object({ error: v.string(), env_var: v.string() }));
		expect(body.error).toBe("tts_provider_unconfigured");
		expect(body.env_var).toBe("MISTRAL_API_KEY");
	});

	it("returns 502 tts_synthesis_failed when the upstream provider errors", async () => {
		const provider = makeFakeTtsProvider({
			error: new TtsProviderError("mistral", "rate limited", 429),
		});
		const { app } = makeApp({ provider });
		const res = await postConversation(app, specForm(ttsSpec()));
		expect(res.status).toBe(502);
		const body = await readJson(res, v.object({ error: v.string(), provider: v.string() }));
		expect(body.error).toBe("tts_synthesis_failed");
		expect(body.provider).toBe("mistral");
	});
});

describe("GET /v1/conversations/:hash/turns/:idx/audio", () => {
	it("serves the synthesized wav for a tts turn", async () => {
		const { app } = makeApp();
		const posted = await postConversation(
			app,
			specForm({
				name: "n",
				turns: [
					{ role: "user", text: "hi", audio: { kind: "tts" } },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const { hash } = await readJson(posted, v.object({ hash: v.string() }));
		const res = await app.request(`/v1/conversations/${hash}/turns/0/audio`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("audio/wav");
		const bytes = new Uint8Array(await res.arrayBuffer());
		// RIFF magic — the body is a real wav, not JSON.
		expect([...bytes.slice(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
	});

	it("serves the uploaded wav for a recorded turn", async () => {
		const { app } = makeApp();
		const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
		const form = new FormData();
		form.set(
			"spec",
			JSON.stringify({
				name: "n",
				turns: [
					{ role: "user", text: "hi", audio: { kind: "recorded", upload_key: "audio_0" } },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		form.set("audio_0", new File([wav], "audio_0.wav", { type: "audio/wav" }));
		const posted = await postConversation(app, form);
		expect(posted.status).toBe(200);
		const { hash } = await readJson(posted, v.object({ hash: v.string() }));
		const res = await app.request(`/v1/conversations/${hash}/turns/0/audio`);
		expect(res.status).toBe(200);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes]).toEqual([...wav]);
	});

	it("returns 404 turn_audio_not_found for an agent turn", async () => {
		const { app } = makeApp();
		const posted = await postConversation(
			app,
			specForm({
				name: "n",
				turns: [
					{ role: "user", text: "hi", audio: { kind: "tts" } },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const { hash } = await readJson(posted, v.object({ hash: v.string() }));
		const res = await app.request(`/v1/conversations/${hash}/turns/1/audio`);
		expect(res.status).toBe(404);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("turn_audio_not_found");
	});

	it("returns 404 for an out-of-range turn idx and unknown hash", async () => {
		const { app } = makeApp();
		const posted = await postConversation(
			app,
			specForm({
				name: "n",
				turns: [
					{ role: "user", text: "hi", audio: { kind: "tts" } },
					{ role: "agent", key: "a0" },
				],
			}),
		);
		const { hash } = await readJson(posted, v.object({ hash: v.string() }));
		expect((await app.request(`/v1/conversations/${hash}/turns/9/audio`)).status).toBe(404);
		expect((await app.request(`/v1/conversations/${"d".repeat(64)}/turns/0/audio`)).status).toBe(
			404,
		);
	});

	it("returns 400 invalid_turn_index for a malformed turn idx", async () => {
		const { app } = makeApp();
		const res = await app.request(`/v1/conversations/${"d".repeat(64)}/turns/zero/audio`);
		expect(res.status).toBe(400);
		const body = await readJson(res, v.object({ error: v.string() }));
		expect(body.error).toBe("invalid_turn_index");
	});
});
