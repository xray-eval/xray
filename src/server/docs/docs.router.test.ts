import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { createApp } from "@/server/server.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
	app = createApp(store, {
		audioRoot: audio.path,
		jobRunner: makeFakeJobRunner(),
		events: makeReplayEvents(),
	});
});

afterAll(() => {
	store.close();
	audio.dispose();
});

describe("OpenAPI doc (/openapi.json)", () => {
	it("declares OpenAPI 3.1 with the expected info block", async () => {
		const doc = await fetchJson("/openapi.json");
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("xray HTTP API");
		expect(doc.info.version).toBeString();
		expect(doc.info.license?.name).toBe("Elastic License 2.0");
	});

	it("contains the new control-plane + OTLP + audio paths", async () => {
		const doc = await fetchJson("/openapi.json");
		const paths = Object.keys(doc.paths ?? {});
		expect(paths).toContain("/healthz");
		expect(paths).toContain("/v1/conversations");
		expect(paths).toContain("/v1/conversations/{id}");
		expect(paths).toContain("/v1/conversations/{id}/replays");
		expect(paths).toContain("/v1/replays");
		expect(paths).toContain("/v1/replays/{id}");
		expect(paths).toContain("/v1/replays/compare");
		expect(paths).toContain("/v1/replays/{id}/analyze");
		expect(paths).toContain("/v1/replays/{id}/events");
		expect(paths).toContain("/v1/otlp/v1/traces");
		expect(paths).toContain("/v1/replays/{id}/audio");
	});
});

describe("/docs", () => {
	it("serves an HTML page that references /openapi.json", async () => {
		const res = await app.request("/docs");
		expect(res.status).toBe(200);
		const ct = res.headers.get("content-type") ?? "";
		expect(ct).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("/openapi.json");
	});
});

interface DocShape {
	openapi?: string;
	info: { title: string; version: string; description?: string; license?: { name: string } };
	paths?: Record<string, unknown>;
}

function isDocShape(value: unknown): value is DocShape {
	return typeof value === "object" && value !== null && "info" in value;
}

async function fetchJson(path: string): Promise<DocShape> {
	const res = await app.request(path);
	expect(res.status).toBe(200);
	const body = await res.json();
	if (!isDocShape(body)) throw new Error(`response from ${path} is not a doc-shaped object`);
	return body;
}
