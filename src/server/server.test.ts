import { makeTempAudioRoot } from "./audio/audio.test-utils.ts";
import { makeFakeJobRunner } from "./jobs/jobs.test-utils.ts";
import { makeReplayEvents } from "./replays/replays.events.ts";
import { createApp } from "./server.ts";
import type { Store } from "./store/store.ts";
import { makeTempStore } from "./store/test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

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

describe("server composition", () => {
	it("exposes the healthz router at /healthz", async () => {
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("mounts the conversations router at /v1/conversations", async () => {
		const res = await app.request("/v1/conversations");
		expect(res.status).toBe(200);
	});

	it("mounts the OTLP router at /v1/otlp/v1/traces", async () => {
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ resourceSpans: [] }),
		});
		expect(res.status).toBe(200);
	});

	it("returns 404 for unknown paths", async () => {
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
	});
});
