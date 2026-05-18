// Seed the running xray dev server so the UI has something to render
// without a real LiveKit-Python agent loop.
//
// Creates one Conversation, then N Replays via POST /v1/replays. For each
// Replay it pushes a small synthetic OTLP/JSON batch with a mix of
// vocabularies (xray.assertion, xray.judge, xray.turn, gen_ai.chat,
// gen_ai.execute_tool, langfuse generation) so the inspector exercises
// every panel.
//
// Usage:
//   pnpm dev                   # in one terminal — dev server on :8080
//   pnpm seed                  # in another — POSTs through the new wire
//
// Override target via env: XRAY_BASE_URL=http://otherhost:9000 pnpm seed

import * as v from "valibot";

const EnvSchema = v.object({
	XRAY_BASE_URL: v.optional(v.string()),
});
const ENV = v.parse(EnvSchema, process.env);
const BASE = ENV.XRAY_BASE_URL ?? "http://localhost:8080";

interface SeedTurn {
	role: "user" | "agent";
	text?: string;
	key: string;
}

const CONVERSATION_ID = "demo-booking-happy-path";
const CONVERSATION_VERSION = "v0001";
const REPLAY_COUNT = 3;

const TURNS: SeedTurn[] = [
	{ role: "user", text: "Hi, I'd like to book a table for two at 7pm.", key: "u0" },
	{ role: "agent", key: "a0" },
	{ role: "user", text: "Anything else I should know?", key: "u1" },
	{ role: "agent", key: "a1" },
];

async function main() {
	await postConversation();
	for (let i = 0; i < REPLAY_COUNT; i++) {
		const replayId = await postReplay(i);
		await pushOtlp(replayId, i);
		await patchReplay(replayId, i);
	}
	console.info(`seeded ${REPLAY_COUNT} replays under ${CONVERSATION_ID}`);
}

async function postConversation() {
	const body = {
		id: CONVERSATION_ID,
		version: CONVERSATION_VERSION,
		title: "Books a table for two — happy path",
		turns: TURNS,
	};
	const res = await fetch(`${BASE}/v1/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`POST /v1/conversations -> ${res.status}`);
}

async function postReplay(idx: number): Promise<string> {
	const body = {
		conversationId: CONVERSATION_ID,
		conversationVersion: CONVERSATION_VERSION,
		modality: "voice",
		runConfig: {
			model: idx % 2 === 0 ? "gpt-4o" : "gpt-4o-mini",
			temperature: 0.3 + idx * 0.2,
		},
	};
	const res = await fetch(`${BASE}/v1/replays`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`POST /v1/replays -> ${res.status}`);
	const parsed = v.parse(v.object({ id: v.string() }), await res.json());
	return parsed.id;
}

async function pushOtlp(replayId: string, idx: number) {
	const startedMs = Date.UTC(2026, 4, 18 + idx, 12, 0, 0);
	const body = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						kv("xray.replay.id", replayId),
						kv("xray.conversation.id", CONVERSATION_ID),
						kv("xray.conversation.version", CONVERSATION_VERSION),
						kv("xray.modality", "voice"),
					],
				},
				scopeSpans: [
					{
						scope: { name: "seed", attributes: [] },
						spans: [
							// Two turn rows — user then agent.
							span({
								name: "xray.turn",
								start: startedMs,
								end: startedMs + 1500,
								attrs: {
									"xray.turn.idx": 0,
									"xray.turn.role": "user",
									"xray.turn.key": "u0",
									"xray.turn.transcript": "Hi, I'd like to book a table for two at 7pm.",
								},
							}),
							span({
								name: "xray.turn",
								start: startedMs + 2000,
								end: startedMs + 4000,
								attrs: {
									"xray.turn.idx": 1,
									"xray.turn.role": "agent",
									"xray.turn.key": "a0",
									"xray.turn.transcript": "Confirmed — two at 7pm. Anything else?",
								},
							}),
							// Assertion result.
							span({
								name: "xray.assertion",
								start: startedMs + 4000,
								end: startedMs + 4001,
								attrs: {
									"xray.turn.idx": 1,
									"xray.assertion.name": "confirms_booking",
									"xray.assertion.status": idx === 1 ? "failed" : "passed",
								},
							}),
							// Judge.
							span({
								name: "xray.judge",
								start: startedMs + 4002,
								end: startedMs + 4500,
								attrs: {
									"xray.judge.status": idx === 1 ? "failed" : "passed",
									"xray.judge.score": 100 - idx * 12,
									"xray.judge.reason":
										idx === 1
											? "Agent omitted the confirmation phrase"
											: "Agent confirmed and offered follow-up",
								},
							}),
							// gen_ai chat.
							span({
								name: "chat gpt-4o",
								start: startedMs + 2100,
								end: startedMs + 3600,
								attrs: {
									"gen_ai.operation.name": "chat",
									"gen_ai.system": "openai",
									"gen_ai.request.model": "gpt-4o",
									"gen_ai.usage.input_tokens": 240 + idx,
									"gen_ai.usage.output_tokens": 88 + idx,
								},
							}),
							// gen_ai tool.
							span({
								name: "execute_tool reserve_table",
								start: startedMs + 3000,
								end: startedMs + 3400,
								attrs: {
									"gen_ai.operation.name": "execute_tool",
									"gen_ai.tool.name": "reserve_table",
									"gen_ai.tool.arguments": JSON.stringify({ party: 2, time: "19:00" }),
									"gen_ai.tool.result": JSON.stringify({ ok: true, confirmation: "AB123" }),
								},
							}),
							// Langfuse generation — surfaces a different provider for diversity.
							span({
								name: "anthropic-summarize",
								start: startedMs + 3700,
								end: startedMs + 3900,
								attrs: {
									"langfuse.observation.type": "generation",
									"langfuse.observation.provider": "anthropic",
									"langfuse.observation.model.name": "claude-3-5-sonnet",
									"langfuse.observation.usage_details.input": 18,
									"langfuse.observation.usage_details.output": 7,
								},
							}),
						],
					},
				],
			},
		],
	};
	const res = await fetch(`${BASE}/v1/otlp/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`POST /v1/otlp/v1/traces -> ${res.status}`);
}

async function patchReplay(replayId: string, idx: number) {
	const body = {
		status: idx === 2 ? "failed" : "completed",
		failureReason: idx === 2 ? "runtime_error" : null,
		finishedAt: new Date(Date.UTC(2026, 4, 18 + idx, 12, 0, 5)).toISOString(),
		transcript:
			"User: Hi, I'd like to book a table for two at 7pm.\n" +
			"Agent: Confirmed — two at 7pm. Anything else?",
	};
	const res = await fetch(`${BASE}/v1/replays/${replayId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`PATCH /v1/replays/:id -> ${res.status}`);
}

// --- helpers ---

function kv(key: string, value: string | number | boolean) {
	if (typeof value === "string") return { key, value: { stringValue: value } };
	if (typeof value === "boolean") return { key, value: { boolValue: value } };
	if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
	return { key, value: { doubleValue: value } };
}

function span(opts: {
	name: string;
	start: number;
	end: number;
	attrs: Record<string, string | number | boolean>;
}) {
	return {
		traceId: pad(opts.name + opts.start, 32),
		spanId: pad(opts.name + opts.start, 16),
		name: opts.name,
		startTimeUnixNano: String(BigInt(opts.start) * 1_000_000n),
		endTimeUnixNano: String(BigInt(opts.end) * 1_000_000n),
		attributes: Object.entries(opts.attrs).map(([k, v2]) => kv(k, v2)),
	};
}

function pad(seed: string, length: number): string {
	const hex = [...seed].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7).toString(16);
	return (hex + "0".repeat(length)).slice(0, length);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
