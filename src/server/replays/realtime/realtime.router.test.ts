import * as v from "valibot";

import { applyEvent } from "@/server/ingest/ingest.service.ts";
import { makeSessionStartedEvent } from "@/server/ingest/ingest.test-utils.ts";
import { ReplayRunResponseSchema } from "@/server/replays/replays.types.ts";
import { createApp } from "@/server/server.ts";
import { getReplayRun } from "@/server/store/replay-runs-repo.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { makeTempAudioRoot } from "./realtime.test-utils.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const ErrorBodySchema = v.object({
	error: v.string(),
	sessionId: v.optional(v.string()),
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

function seedSource(sessionId: string): void {
	applyEvent(store, sessionId, makeSessionStartedEvent({ agentId: "x" }));
}

async function post(body: unknown): Promise<Response> {
	return app.request("http://test.local/v1/replays/realtime", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

describe("POST /v1/replays/realtime", () => {
	it("returns 202 with mode='realtime' for a valid wss URL", async () => {
		seedSource("src-1");
		const res = await post({
			sourceSessionId: "src-1",
			webhookUrl: "wss://example.test/realtime",
		});
		expect(res.status).toBe(202);
		const body = v.parse(ReplayRunResponseSchema, await res.json());
		expect(body.mode).toBe("realtime");
		expect(body.status).toBe("pending");
		expect(body.sourceSessionId).toBe("src-1");
		expect(getReplayRun(store.db, body.id)?.mode).toBe("realtime");
	});

	it("accepts ws:// in addition to wss://", async () => {
		seedSource("src-1");
		const res = await post({
			sourceSessionId: "src-1",
			webhookUrl: "ws://example.test/realtime",
		});
		expect(res.status).toBe(202);
	});

	it("rejects an https URL with 400 (the realtime endpoint requires ws/wss)", async () => {
		seedSource("src-1");
		const res = await post({
			sourceSessionId: "src-1",
			webhookUrl: "https://example.test/realtime",
		});
		expect(res.status).toBe(400);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("invalid_realtime_replay_request");
	});

	it("returns 404 when the source session doesn't exist", async () => {
		const res = await post({
			sourceSessionId: "missing",
			webhookUrl: "ws://example.test/realtime",
		});
		expect(res.status).toBe(404);
		const body = v.parse(ErrorBodySchema, await res.json());
		expect(body.error).toBe("source_session_not_found");
		expect(body.sessionId).toBe("missing");
	});

	it("returns 400 on malformed JSON body", async () => {
		const res = await post("not valid json");
		expect(res.status).toBe(400);
	});

	it("rejects a body that exceeds the 4KB cap with 413", async () => {
		const huge = { sourceSessionId: "x".repeat(5000), webhookUrl: "ws://x" };
		const res = await post(huge);
		expect(res.status).toBe(413);
	});
});
