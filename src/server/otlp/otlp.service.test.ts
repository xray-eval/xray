import { eq } from "drizzle-orm";

import { upsertConversation } from "@/server/conversations/conversations.service.ts";
import { makeConversationSpec } from "@/server/conversations/conversations.test-utils.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import { makeCreateReplayRequest } from "@/server/replays/replays.test-utils.ts";
import { modelUsage, spans, toolCalls } from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import { TooManySpansPerRequestError } from "./otlp.errors.ts";
import { ingestOtlpTraces } from "./otlp.service.ts";
import { makeOtlpRequest } from "./otlp.test-utils.ts";
import { MAX_SPANS_PER_REPLAY, MAX_SPANS_PER_REQUEST } from "./otlp.types.ts";
import { describe, expect, it } from "bun:test";

function setupReplay(): { store: ReturnType<typeof makeTempStore>; replayId: string } {
	const store = makeTempStore();
	upsertConversation(store, makeConversationSpec({ id: "c", version: "v1" }));
	const detail = createReplay(
		store,
		makeCreateReplayRequest({ conversation_id: "c", conversation_version: "v1" }),
	);
	return { store, replayId: detail.id };
}

describe("ingestOtlpTraces — filter posture", () => {
	it("drops a span with no xray.replay.id (silent)", () => {
		const { store } = setupReplay();
		const req = makeOtlpRequest({
			replayId: null,
			spans: [{ name: "xray.assertion" }],
		});
		const { result } = ingestOtlpTraces(store, req);
		expect(result.persistedSpans).toBe(0);
		expect(result.rejectedSpans).toBe(1);
		expect(store.db.select().from(spans).all()).toEqual([]);
		store.close();
	});

	it("drops a span whose replay_id doesn't exist (silent)", () => {
		const { store } = setupReplay();
		const req = makeOtlpRequest({
			replayId: "00000000-0000-0000-0000-000000000099",
			spans: [{ name: "xray.assertion" }],
		});
		const { result } = ingestOtlpTraces(store, req);
		expect(result.persistedSpans).toBe(0);
		expect(result.rejectedSpans).toBe(1);
		store.close();
	});

	it("drops a span of unrecognized vocabulary (silent)", () => {
		const { store, replayId } = setupReplay();
		const req = makeOtlpRequest({
			replayId,
			spans: [{ name: "random.span", attributes: { "foo.bar": "x" } }],
		});
		const { result } = ingestOtlpTraces(store, req);
		expect(result.persistedSpans).toBe(0);
		expect(result.rejectedSpans).toBe(1);
		store.close();
	});
});

describe("ingestOtlpTraces — xray vocabulary (raw spans only)", () => {
	it("persists xray.* spans as raw spans only (no structured extraction in v0.2)", () => {
		const { store, replayId } = setupReplay();
		const req = makeOtlpRequest({
			replayId,
			spans: [
				{
					name: "xray.assertion",
					attributes: {
						"xray.turn.idx": 0,
						"xray.assertion.name": "first_turn_responds",
						"xray.assertion.status": "passed",
					},
				},
				{ name: "xray.judge", attributes: { "xray.judge.status": "failed" } },
				{ name: "xray.turn", attributes: { "xray.turn.idx": 0, "xray.turn.role": "agent" } },
				{ name: "xray.stage.stt" },
				{ name: "xray.stage.tts" },
			],
		});
		const { result } = ingestOtlpTraces(store, req);
		expect(result.persistedSpans).toBe(5);
		const rows = store.db.select().from(spans).where(eq(spans.replayId, replayId)).all();
		expect(rows).toHaveLength(5);
		for (const r of rows) expect(r.vocabulary).toBe("xray");
	});
});

describe("ingestOtlpTraces — gen_ai vocabulary", () => {
	it("extracts model_usage from a chat span", () => {
		const { store, replayId } = setupReplay();
		const req = makeOtlpRequest({
			replayId,
			spans: [
				{
					name: "chat gpt-4o",
					startedAtMs: 1000,
					endedAtMs: 1500,
					attributes: {
						"gen_ai.operation.name": "chat",
						"gen_ai.system": "openai",
						"gen_ai.request.model": "gpt-4o",
						"gen_ai.usage.input_tokens": 42,
						"gen_ai.usage.output_tokens": 17,
					},
				},
			],
		});
		ingestOtlpTraces(store, req);
		const usage = store.db.select().from(modelUsage).where(eq(modelUsage.replayId, replayId)).get();
		expect(usage?.provider).toBe("openai");
		expect(usage?.model).toBe("gpt-4o");
		expect(usage?.inputTokens).toBe(42);
		expect(usage?.outputTokens).toBe(17);
		expect(usage?.totalTokens).toBe(59);
		expect(usage?.latencyMs).toBe(500);
		store.close();
	});

	it("extracts tool_calls from an execute_tool span", () => {
		const { store, replayId } = setupReplay();
		const req = makeOtlpRequest({
			replayId,
			spans: [
				{
					name: "execute_tool lookup",
					attributes: {
						"gen_ai.operation.name": "execute_tool",
						"gen_ai.tool.name": "lookup",
						"gen_ai.tool.arguments": '{"q":"hi"}',
					},
				},
			],
		});
		ingestOtlpTraces(store, req);
		const tc = store.db.select().from(toolCalls).where(eq(toolCalls.replayId, replayId)).get();
		expect(tc?.name).toBe("lookup");
		expect(tc?.argsJson).toBe('{"q":"hi"}');
		store.close();
	});
});

describe("ingestOtlpTraces — langfuse vocabulary", () => {
	it("extracts model_usage from a generation observation", () => {
		const { store, replayId } = setupReplay();
		const req = makeOtlpRequest({
			replayId,
			spans: [
				{
					name: "anthropic-call",
					attributes: {
						"langfuse.observation.type": "generation",
						"langfuse.observation.provider": "anthropic",
						"langfuse.observation.model.name": "claude-3-5-sonnet",
						"langfuse.observation.usage_details.input": 5,
						"langfuse.observation.usage_details.output": 9,
					},
				},
			],
		});
		ingestOtlpTraces(store, req);
		const usage = store.db.select().from(modelUsage).where(eq(modelUsage.replayId, replayId)).get();
		expect(usage?.provider).toBe("anthropic");
		expect(usage?.model).toBe("claude-3-5-sonnet");
		expect(usage?.inputTokens).toBe(5);
		expect(usage?.outputTokens).toBe(9);
		store.close();
	});
});

describe("ingestOtlpTraces — limits", () => {
	it("throws TooManySpansPerRequestError above the per-request cap", () => {
		const { store, replayId } = setupReplay();
		const tooMany = Array.from({ length: MAX_SPANS_PER_REQUEST + 1 }, () => ({
			name: "xray.assertion",
		}));
		const req = makeOtlpRequest({ replayId, spans: tooMany });
		expect(() => ingestOtlpTraces(store, req)).toThrow(TooManySpansPerRequestError);
		store.close();
	});

	it("counts over-cap spans into partialSuccess.rejectedSpans without rolling back under-cap inserts in the same batch", () => {
		const { store, replayId } = setupReplay();
		const bulk: {
			replayId: string;
			traceId: string;
			spanId: string;
			name: string;
			vocabulary: "xray";
			startedAt: string;
			endedAt: string;
			attributesJson: string;
		}[] = [];
		for (let i = 0; i < MAX_SPANS_PER_REPLAY; i++) {
			bulk.push({
				replayId,
				traceId: `t${i}`,
				spanId: `seed-s${i}`,
				name: "xray.assertion",
				vocabulary: "xray",
				startedAt: "2026-05-18T12:00:00.000Z",
				endedAt: "2026-05-18T12:00:00.001Z",
				attributesJson: "{}",
			});
		}
		for (let i = 0; i < bulk.length; i += 250) {
			store.db
				.insert(spans)
				.values(bulk.slice(i, i + 250))
				.run();
		}
		const req = makeOtlpRequest({
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
		const { response, result } = ingestOtlpTraces(store, req);
		expect(result.persistedSpans).toBe(0);
		expect(result.rejectedSpans).toBe(1);
		expect(response.partialSuccess?.rejectedSpans).toBe(1);
		store.close();
	});
});
