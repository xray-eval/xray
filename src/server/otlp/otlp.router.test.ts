import { Hono } from "hono";
import * as v from "valibot";

import { upsertConversation } from "@/server/conversations/conversations.service.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { readJson } from "@/server/core/test-utils.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import { makeCreateReplayRequest } from "@/server/replays/replays.test-utils.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { createOtlpRouter } from "./otlp.router.ts";
import { makeOtlpRequest } from "./otlp.test-utils.ts";
import { describe, expect, it } from "bun:test";

function makeApp() {
	const store = makeTempStore();
	upsertConversation(store, makeConversationSpec({ id: "c", version: "v1" }));
	const replay = createReplay(
		store,
		makeCreateReplayRequest({ conversationId: "c", conversationVersion: "v1" }),
	);
	const app = new Hono().route("/v1", createOtlpRouter(store));
	return { app, store, replayId: replay.id };
}

describe("POST /v1/otlp/v1/traces", () => {
	it("returns 200 + partialSuccess body on a valid OTLP/JSON request", async () => {
		const { app, replayId } = makeApp();
		const body = makeOtlpRequest({
			replayId,
			spans: [
				{
					name: "xray.assertion",
					attributes: {
						"xray.turn.idx": 0,
						"xray.assertion.name": "n",
						"xray.assertion.status": "passed",
					},
				},
			],
		});
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(200);
		const json = await readJson(
			res,
			v.object({
				partialSuccess: v.optional(v.object({ rejectedSpans: v.optional(v.number()) })),
			}),
		);
		expect(json.partialSuccess?.rejectedSpans).toBe(0);
	});

	it("returns 415 for non-JSON content-type", async () => {
		const { app, replayId } = makeApp();
		const body = makeOtlpRequest({ replayId, spans: [{ name: "xray.assertion" }] });
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/x-protobuf" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(415);
	});

	it("returns 400 for unparseable JSON body", async () => {
		const { app } = makeApp();
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(res.status).toBe(400);
	});
});
