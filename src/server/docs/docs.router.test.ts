import { makeTempAudioRoot } from "@/server/audio/audio.test-utils.ts";
import { createApp } from "@/server/server.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// One app instance per file — the doc endpoints are pure functions of route
// metadata; they never read the store or touch audio. Per-test isolation would
// just rebuild the same spec eight times.
let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
	app = createApp(store, { audioRoot: audio.path });
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

	it("contains at least one path per router mounted in server.ts", async () => {
		const doc = await fetchJson("/openapi.json");
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/healthz");
		expect(paths).toContain("/v1/sessions/{id}/events");
		expect(paths).toContain("/v1/sessions");
		expect(paths).toContain("/v1/sessions/{id}");
		expect(paths).toContain("/v1/replays");
		expect(paths).toContain("/v1/replays/{id}");
		expect(paths).toContain("/v1/replays/realtime");
		expect(paths).toContain("/v1/sessions/{id}/turns/{idx}/audio");
	});

	it("declares the text-replay webhook under top-level webhooks:", async () => {
		const doc = await fetchJson("/openapi.json");
		const op = doc.webhooks?.textReplay?.post;
		expect(op).toBeDefined();
		expect(op?.requestBody?.content?.["application/json"]?.schema).toBeDefined();
		expect(op?.responses?.["200"]?.content?.["application/json"]?.schema).toBeDefined();
	});
});

describe("AsyncAPI doc (/asyncapi.json)", () => {
	it("declares AsyncAPI 3.0 with the expected info block", async () => {
		const doc = await fetchJson("/asyncapi.json");
		expect(doc.asyncapi).toBe("3.0.0");
		expect(doc.info.title).toContain("realtime-replay");
		expect(doc.info.description).toContain("```mermaid");
	});

	it("declares one send and one receive operation", async () => {
		const doc = await fetchJson("/asyncapi.json");
		expect(doc.operations.sendToWebhook?.action).toBe("send");
		expect(doc.operations.receiveFromWebhook?.action).toBe("receive");
	});

	it("contains every ClientFrame variant", async () => {
		const doc = await fetchJson("/asyncapi.json");
		const names = Object.keys(doc.components.messages);
		expect(names).toContain("client.session.start");
		expect(names).toContain("client.user_audio.append");
		expect(names).toContain("client.user_audio.commit");
		expect(names).toContain("client.session.end");
	});

	it("contains every ServerFrame variant", async () => {
		const doc = await fetchJson("/asyncapi.json");
		const names = Object.keys(doc.components.messages);
		expect(names).toContain("server.agent_audio.delta");
		expect(names).toContain("server.agent_transcript.delta");
		expect(names).toContain("server.tool_called");
		expect(names).toContain("server.turn.done");
		expect(names).toContain("server.error");
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

interface WebhookOperation {
	requestBody?: { content?: Record<string, { schema?: unknown }> };
	responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

interface DocShape {
	openapi?: string;
	asyncapi?: string;
	info: {
		title: string;
		version: string;
		description?: string;
		license?: { name: string };
	};
	paths?: Record<string, unknown>;
	webhooks?: { textReplay?: { post?: WebhookOperation } };
	operations: { sendToWebhook?: { action: string }; receiveFromWebhook?: { action: string } };
	components: { messages: Record<string, unknown> };
}

function isDocShape(value: unknown): value is DocShape {
	return typeof value === "object" && value !== null && "info" in value;
}

async function fetchJson(path: string): Promise<DocShape> {
	const res = await app.request(path);
	expect(res.status).toBe(200);
	const body = await res.json();
	if (!isDocShape(body)) {
		throw new Error(`response from ${path} is not a doc-shaped object`);
	}
	return body;
}
