// Seed the running xray dev server with fake conversations so the UI has
// something to render without a real agent loop. Two modes are seeded so a
// developer sees one of each:
//
//   * text  — text-only, no audio (default custom-loop shape)
//   * v2v   — text + real per-turn TTS audio for both user and agent turns
//             so the realtime-replay engine has playable, intelligible audio
//             to stream end-to-end. Requires VOICE=1 + OPENAI_API_KEY;
//             without it the v2v session still renders but its realtime
//             replay has no audio to forward.
//
// Usage:
//   pnpm dev                          # in one terminal — dev server on :8080
//   pnpm seed                         # in another — POSTs events through /v1/sessions/:id/events
//   VOICE=1 OPENAI_API_KEY=sk-... pnpm seed
//                                     # synthesizes per-turn audio via OpenAI TTS for the
//                                     # `v2v` session so playback is a real conversation,
//                                     # not silence.
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

/**
 * One conversation shape per audio strategy so a developer running `pnpm
 * seed` always has a working example of each:
 *
 *   text — no audio uploaded, ever
 *   v2v  — per-turn TTS audio in the format the realtime-replay engine
 *          can stream end-to-end (WAV) when VOICE=1 + OPENAI_API_KEY are
 *          set. The startup warning flags when VOICE is off so the
 *          operator isn't surprised that v2v replay has nothing to forward.
 */
type SeedMode = "text" | "v2v";

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
	mode: SeedMode;
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

// Exactly one session per audio strategy — naming mirrors the `mode` so a
// developer scanning the list view instantly sees which path each row
// exercises. Tools and the live (no-`session_ended`) edge case are folded
// into the two modes' content so the variety stays without multiplying rows.
const SESSIONS: SeedSession[] = [
	{
		// Text-only: tool-heavy support flow, no audio anywhere. Default
		// shape for a custom-loop developer who doesn't ship audio.
		id: "seed-mode-text",
		agentId: "seed-mode-text",
		mode: "text",
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
		// V2V: with VOICE=1 + OPENAI_API_KEY, every turn gets a real TTS WAV
		// (PCM16 24 kHz mono) — the format OpenAI Realtime accepts as input,
		// so this seeded session can be driven end-to-end through the realtime
		// replay engine without re-recording anything.
		id: "seed-mode-v2v",
		agentId: "concierge-v2v",
		mode: "v2v",
		startedAt: isoAt(ANCHOR, 40 * 60 * 1000),
		durationMs: 22_000,
		turns: [
			{
				idx: 0,
				role: "user",
				text: "Book me a table for two at the bistro tonight at seven.",
				offsetMs: 400,
			},
			{
				idx: 1,
				role: "agent",
				text: "Got it — two people, seven PM. Checking availability now.",
				offsetMs: 1_700,
				responseLatencyMs: 720,
				toolCalls: [
					{
						idx: 0,
						name: "book_table",
						args: { party_size: 2, time: "19:00" },
						result: { confirmed: true, reference: "BIS-9821" },
						latencyMs: 380,
					},
				],
			},
			{
				idx: 2,
				role: "agent",
				text: "Confirmed — reference BIS-9821. You'll get an SMS shortly.",
				offsetMs: 6_200,
				responseLatencyMs: 480,
			},
			{
				idx: 3,
				role: "user",
				text: "Perfect, thanks.",
				offsetMs: 10_500,
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
		if (
			(turn.role === "user" || turn.role === "agent") &&
			session.mode === "v2v" &&
			VOICE_ENABLED
		) {
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
	const v2vSession = SESSIONS.find((s) => s.mode === "v2v");
	if (v2vSession !== undefined && !VOICE_ENABLED) {
		console.warn(
			`! ${v2vSession.id} is mode=v2v but VOICE=1 is not set — the session will seed with no audio, ` +
				`so the realtime-replay engine will have nothing to forward. Re-run with ` +
				`VOICE=1 OPENAI_API_KEY=sk-... pnpm seed to get a real audio conversation.`,
		);
	}
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
