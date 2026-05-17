// Seed the running xray dev server with fake conversations so the UI has
// something to render without a real agent loop.
//
// Usage:
//   pnpm dev                          # in one terminal — dev server on :8080
//   pnpm seed                         # in another — POSTs events through /v1/sessions/:id/events
//   VOICE=1 OPENAI_API_KEY=sk-... pnpm seed
//                                     # also synthesizes per-turn audio via OpenAI TTS and
//                                     # POSTs it to /v1/sessions/:id/turns/:idx/audio
//
// Override target via env: XRAY_BASE_URL=http://otherhost:9000 pnpm seed
//
// This is the same path a custom voice-agent loop uses (the JSONL fixture
// docs in CLAUDE.md point at this endpoint), so the wire contract gets
// exercised end-to-end rather than poked at via the store directly.

import * as v from "valibot";

import { isTruthy, synthesizeAndUpload } from "./lib/voice.ts";

// Env codec — parse once at startup per boundary-validation.md, not as
// scattered untyped index lookups.
const EnvSchema = v.object({
	XRAY_BASE_URL: v.optional(v.string()),
	VOICE: v.optional(v.string()),
	OPENAI_API_KEY: v.optional(v.string()),
	OPENAI_TTS_MODEL: v.optional(v.string()),
	OPENAI_TTS_VOICE: v.optional(v.string()),
});
const ENV = v.parse(EnvSchema, process.env);
const BASE = ENV.XRAY_BASE_URL ?? "http://localhost:8080";

const VOICE_ENABLED = isTruthy(ENV.VOICE);
const TTS_MODEL = ENV.OPENAI_TTS_MODEL ?? "tts-1";
// Two voices so user/agent turns sound different in playback.
const USER_VOICE = "shimmer";
const AGENT_VOICE = ENV.OPENAI_TTS_VOICE ?? "alloy";

if (VOICE_ENABLED && ENV.OPENAI_API_KEY === undefined) {
	console.error("VOICE=1 set but OPENAI_API_KEY is missing — pass it or unset VOICE.");
	process.exit(1);
}

type Role = "user" | "agent" | "tool" | "system";

interface SeedToolCall {
	idx: number;
	name: string;
	args: unknown;
	result?: unknown;
	latencyMs?: number;
}

interface SeedTurn {
	idx: number;
	role: Role;
	text: string;
	offsetMs: number;
	responseLatencyMs?: number;
	interrupted?: boolean;
	interruptedAtMs?: number;
	toolCalls?: SeedToolCall[];
}

interface SeedSession {
	id: string;
	agentId: string;
	startedAt: string;
	durationMs?: number;
	turns: SeedTurn[];
}

// Anchor everything to "now − 1h" so timestamps stay relevant when you reseed
// next week. Each session's startedAt drifts back in 10-minute buckets so the
// list view shows obvious ordering.
const NOW = Date.now();
const ANCHOR = NOW - 60 * 60 * 1000;

function isoAt(baseMs: number, offsetMs: number): string {
	return new Date(baseMs + offsetMs).toISOString();
}

const SESSIONS: SeedSession[] = [
	{
		id: "seed-pipeline-support",
		agentId: "support-pipeline",
		startedAt: isoAt(ANCHOR, 0),
		durationMs: 42_000,
		turns: [
			{
				idx: 0,
				role: "user",
				text: "Hi, my order #4821 hasn't shipped yet — can you check?",
				offsetMs: 500,
			},
			{
				idx: 1,
				role: "agent",
				text: "Let me look that up for you.",
				offsetMs: 1_800,
				responseLatencyMs: 620,
				toolCalls: [
					{
						idx: 0,
						name: "lookup_order",
						args: { order_id: "4821" },
						result: { status: "packing", carrier: "DHL", eta: "2026-05-19" },
						latencyMs: 240,
					},
				],
			},
			{
				idx: 2,
				role: "agent",
				text: "Your order is in packing and will ship via DHL with an ETA of May 19.",
				offsetMs: 5_400,
				responseLatencyMs: 780,
			},
			{
				idx: 3,
				role: "user",
				text: "Great, thanks!",
				offsetMs: 9_200,
			},
		],
	},
	{
		id: "seed-voice-bargein",
		agentId: "concierge-v2v",
		startedAt: isoAt(ANCHOR, 12 * 60 * 1000),
		durationMs: 18_500,
		turns: [
			{
				idx: 0,
				role: "user",
				text: "What's the weather in Paris tomorrow?",
				offsetMs: 300,
			},
			{
				idx: 1,
				role: "agent",
				text: "Tomorrow in Paris you can expect partly cloudy skies with a high around twenty-two…",
				offsetMs: 1_200,
				responseLatencyMs: 880,
				interrupted: true,
				interruptedAtMs: 1_400,
				toolCalls: [
					{
						idx: 0,
						name: "get_weather",
						args: { city: "Paris", when: "tomorrow" },
						result: { tempC: 22, summary: "partly cloudy", precipitation: 0.05 },
						latencyMs: 310,
					},
				],
			},
			{
				idx: 2,
				role: "user",
				text: "Actually, just give me the temperature.",
				offsetMs: 4_100,
			},
			{
				idx: 3,
				role: "agent",
				text: "Twenty-two degrees Celsius.",
				offsetMs: 5_300,
				responseLatencyMs: 410,
			},
		],
	},
	{
		id: "seed-tools-heavy",
		agentId: "research-pipeline",
		startedAt: isoAt(ANCHOR, 28 * 60 * 1000),
		durationMs: 64_000,
		turns: [
			{
				idx: 0,
				role: "user",
				text: "Find me three recent papers about retrieval-augmented generation.",
				offsetMs: 500,
			},
			{
				idx: 1,
				role: "agent",
				text: "Searching across arXiv and Semantic Scholar.",
				offsetMs: 2_100,
				responseLatencyMs: 540,
				toolCalls: [
					{
						idx: 0,
						name: "search_arxiv",
						args: { query: "retrieval augmented generation", limit: 3 },
						result: {
							papers: [
								{ id: "2405.12345", title: "Self-RAG: Learning to Retrieve…" },
								{ id: "2406.00987", title: "Adaptive RAG with reflection" },
							],
						},
						latencyMs: 1_120,
					},
					{
						idx: 1,
						name: "search_semantic_scholar",
						args: { query: "retrieval augmented generation", year_min: 2025 },
						result: { papers: [{ id: "SS:9928", title: "RAG benchmarks revisited" }] },
						latencyMs: 980,
					},
				],
			},
			{
				idx: 2,
				role: "agent",
				text: "I found three: Self-RAG, Adaptive RAG with reflection, and RAG benchmarks revisited.",
				offsetMs: 8_900,
				responseLatencyMs: 1_320,
			},
			{
				idx: 3,
				role: "user",
				text: "Summarize the first one in two sentences.",
				offsetMs: 14_200,
			},
			{
				idx: 4,
				role: "agent",
				text: "Self-RAG trains the model to decide when retrieval is needed and to critique its own retrieved passages. It outperforms vanilla RAG on long-form generation by gating the retrieval step at inference time.",
				offsetMs: 17_400,
				responseLatencyMs: 2_100,
				toolCalls: [
					{
						idx: 0,
						name: "fetch_paper_abstract",
						args: { id: "2405.12345" },
						result: { abstract: "Self-RAG trains the model to decide…" },
						latencyMs: 460,
					},
				],
			},
		],
	},
	{
		id: "seed-live",
		agentId: "support-pipeline",
		startedAt: isoAt(ANCHOR, 55 * 60 * 1000),
		// No `durationMs` and no `session_ended` — this session renders as
		// "in progress" in the list view, useful for exercising that branch.
		turns: [
			{
				idx: 0,
				role: "user",
				text: "Hey, are you there?",
				offsetMs: 200,
			},
			{
				idx: 1,
				role: "agent",
				text: "Yes, I'm here — how can I help?",
				offsetMs: 900,
				responseLatencyMs: 350,
			},
		],
	},
];

interface PostOptions {
	sessionId: string;
	body: { type: string } & Record<string, unknown>;
}

async function postEvent({ sessionId, body }: PostOptions): Promise<void> {
	const res = await fetch(`${BASE}/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`POST ${sessionId} ${body.type} → ${res.status}: ${text}`);
	}
}

async function seedSession(session: SeedSession): Promise<void> {
	await postEvent({
		sessionId: session.id,
		body: {
			type: "session_started",
			agentId: session.agentId,
			startedAt: session.startedAt,
		},
	});
	const baseMs = Date.parse(session.startedAt);
	for (const turn of session.turns) {
		await postEvent({
			sessionId: session.id,
			body: {
				type: "turn_completed",
				idx: turn.idx,
				role: turn.role,
				text: turn.text,
				timestamp: isoAt(baseMs, turn.offsetMs),
				...(turn.responseLatencyMs !== undefined
					? { responseLatencyMs: turn.responseLatencyMs }
					: {}),
				...(turn.interrupted !== undefined ? { interrupted: turn.interrupted } : {}),
				...(turn.interruptedAtMs !== undefined ? { interruptedAtMs: turn.interruptedAtMs } : {}),
			},
		});
		for (const call of turn.toolCalls ?? []) {
			await postEvent({
				sessionId: session.id,
				body: {
					type: "tool_called",
					turnIdx: turn.idx,
					idx: call.idx,
					name: call.name,
					args: call.args,
					...(call.result !== undefined ? { result: call.result } : {}),
					...(call.latencyMs !== undefined ? { latencyMs: call.latencyMs } : {}),
				},
			});
		}
		if (VOICE_ENABLED && (turn.role === "user" || turn.role === "agent")) {
			await runVoice(session.id, turn.idx, turn.role, turn.text);
		}
	}
	if (session.durationMs !== undefined) {
		await postEvent({
			sessionId: session.id,
			body: {
				type: "session_ended",
				endedAt: isoAt(baseMs, session.durationMs),
				durationMs: session.durationMs,
			},
		});
	}
}

async function runVoice(
	sessionId: string,
	turnIdx: number,
	role: "user" | "agent",
	text: string,
): Promise<void> {
	// The guard at module init narrowed OPENAI_API_KEY to non-undefined when
	// VOICE_ENABLED; the `?? ""` here is purely a type guard.
	const apiKey = ENV.OPENAI_API_KEY ?? "";
	const res = await synthesizeAndUpload({
		apiKey,
		xrayBase: BASE,
		sessionId,
		turnIdx,
		text,
		ttsModel: TTS_MODEL,
		voice: role === "user" ? USER_VOICE : AGENT_VOICE,
	});
	if (!res.ok) {
		console.warn(`  ! audio for ${sessionId} turn ${turnIdx} (${role}) failed: ${res.reason}`);
	}
}

async function main(): Promise<void> {
	console.info(
		`Seeding ${SESSIONS.length} sessions to ${BASE}${VOICE_ENABLED ? " (voice on)" : ""}`,
	);
	// Quick reachability check so the failure mode is obvious if the dev
	// server isn't running, instead of N opaque fetch errors.
	try {
		const ping = await fetch(`${BASE}/healthz`);
		if (!ping.ok) throw new Error(`healthz returned ${ping.status}`);
	} catch (cause) {
		console.error(`Cannot reach xray at ${BASE} — is \`pnpm dev\` running?`);
		console.error(cause);
		process.exit(1);
	}

	for (const session of SESSIONS) {
		await seedSession(session);
		console.info(`  + ${session.id} (${session.turns.length} turns)`);
	}
	console.info("Done. Open http://localhost:8080 to see them.");
}

await main();
