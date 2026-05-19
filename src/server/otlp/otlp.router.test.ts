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
import { MAX_OTLP_BODY_BYTES, MAX_SPANS_PER_REQUEST } from "./otlp.types.ts";
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

	it("returns 413 with body_too_large shape when the body exceeds MAX_OTLP_BODY_BYTES", async () => {
		const { app } = makeApp();
		const oversize = "x".repeat(MAX_OTLP_BODY_BYTES + 1);
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": String(oversize.length) },
			body: oversize,
		});
		expect(res.status).toBe(413);
		const json = await readJson(
			res,
			v.object({ error: v.literal("body_too_large"), maxBytes: v.number() }),
		);
		expect(json.maxBytes).toBe(MAX_OTLP_BODY_BYTES);
	});

	it("returns 400 with too_many_spans_per_request shape when > MAX_SPANS_PER_REQUEST spans are sent", async () => {
		const { app, replayId } = makeApp();
		const spans = Array.from({ length: MAX_SPANS_PER_REQUEST + 1 }, (_, i) => ({
			name: "xray.assertion",
			attributes: {
				"xray.turn.idx": 0,
				"xray.assertion.name": `n-${i}`,
				"xray.assertion.status": "passed",
			},
		}));
		const body = makeOtlpRequest({ replayId, spans });
		const res = await app.request("/v1/otlp/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(400);
		const json = await readJson(
			res,
			v.object({
				error: v.literal("too_many_spans_per_request"),
				maxSpans: v.number(),
				received: v.number(),
			}),
		);
		expect(json.maxSpans).toBe(MAX_SPANS_PER_REQUEST);
		expect(json.received).toBe(MAX_SPANS_PER_REQUEST + 1);
	});
});
