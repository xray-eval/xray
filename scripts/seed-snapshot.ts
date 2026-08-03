/**
 * Regenerate the committed `snapshot/` fixture from scratch.
 *
 * It builds two scripted conversations, synthesizes a stereo WAV per replay, and
 * runs each through the REAL analyze pipeline (VAD → per-turn metrics →
 * assertion evaluation). The result — overlapping audio, a genuine `yield_ms`
 * metric, and a passing `yielded_within_ms` assertion — is written to
 * `snapshot/xray.db` + `snapshot/audio/` so a developer can open the inspector
 * and see an authentic interruption without a live agent or any provider API
 * keys.
 *
 * Nothing here is random or clock-dependent, so re-running produces a
 * byte-identical fixture — including the wall-clock columns the job processors
 * stamp, which `pinGeneratedTimestamps` rewrites from `startedAt` once each run
 * completes. Verify with two runs and `shasum snapshot/xray.db`; a binary diff
 * in a PR that didn't touch this script is a real signal, not noise.
 * Run: `bun run scripts/seed-snapshot.ts`.
 *
 * The one concession to "authentic": transcripts are scripted rather than
 * produced by a real STT provider (there's no key offline). Each turn's audio
 * carries a distinct amplitude so the stand-in provider can map a slice back to
 * its line — VAD, turn derivation, metrics, and assertions all run for real.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { StereoWav } from "@/server/audio/audio.types.ts";
import { writeStereoWav } from "@/server/audio/audio.wav.ts";
import {
	canonicalizeAndHashSpec,
	ensureConversation,
} from "@/server/conversations/conversations.service.ts";
import type { ConversationTurn } from "@/server/conversations/conversations.types.ts";
import { makeAnalyzeProcessor } from "@/server/jobs/analyze-replay/analyze-replay.processor.ts";
import { makeCalculateMetricsProcessor } from "@/server/jobs/calculate-metrics/calculate-metrics.processor.ts";
import { makeEvaluateReplayProcessor } from "@/server/jobs/evaluate-replay/evaluate-replay.processor.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import type { JudgeProvider } from "@/server/judges/judges.types.ts";
import { ingestOtlpTraces } from "@/server/otlp/otlp.service.ts";
import type { ExportTraceServiceRequest } from "@/server/otlp/otlp.types.ts";
import { ExportTraceServiceRequestSchema } from "@/server/otlp/otlp.types.ts";
import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { createReplay } from "@/server/replays/replays.service.ts";
import {
	assertionResults,
	replayEvaluations,
	replayMetrics,
	replays,
} from "@/server/store/schema.ts";
import { openStore } from "@/server/store/store.ts";
import type {
	TranscriptionProvider,
	TranscriptionResult,
} from "@/server/transcription/transcription.types.ts";

const SNAPSHOT_DIR = new URL("../snapshot", import.meta.url).pathname;
const DB_PATH = join(SNAPSHOT_DIR, "xray.db");
const AUDIO_ROOT = join(SNAPSHOT_DIR, "audio");

const SAMPLE_RATE = 48_000;
const TONE_HZ = 200;

// One line per turn. The distinct amplitude doubles as the marker the
// stand-in transcription provider reads back to recover the line — so
// amplitudes are unique across BOTH scripts, not just within one.
interface ScriptedTurn {
	readonly role: "user" | "agent";
	readonly startMs: number;
	readonly endMs: number;
	readonly amplitude: number;
	readonly transcript: string;
}

const BARGE_IN_SCRIPT: readonly ScriptedTurn[] = [
	{
		role: "user",
		startMs: 0,
		endMs: 1800,
		amplitude: 6_000,
		transcript: "Book me a flight to Paris.",
	},
	// The agent starts answering, gets cut off, and keeps talking ~300ms.
	{
		role: "agent",
		startMs: 2300,
		endMs: 4600,
		amplitude: 9_000,
		transcript: "Sure — I'm booking a flight to Paris",
	},
	// The user barges in 300ms before the agent stops (4300 < 4600).
	{ role: "user", startMs: 4300, endMs: 5500, amplitude: 12_000, transcript: "No, wait — Berlin!" },
	{
		role: "agent",
		startMs: 6000,
		endMs: 8000,
		amplitude: 15_000,
		transcript: "Got it, booking a flight to Berlin instead.",
	},
];

// A short, clean two-turn exchange: no interruption, so `yield_ms` has no
// sample here and the compare view shows a metric whose `n` legitimately
// differs per row. Also a third of the audio bytes of the barge-in script,
// which is what keeps a 5-config fixture from dominating the repo.
const LOOKUP_SCRIPT: readonly ScriptedTurn[] = [
	{
		role: "user",
		startMs: 0,
		endMs: 1200,
		amplitude: 18_000,
		transcript: "What time is my flight?",
	},
	{
		role: "agent",
		startMs: 1600,
		endMs: 3200,
		amplitude: 21_000,
		transcript: "Your flight leaves at 6pm.",
	},
];

interface ScriptedConversation {
	readonly key: string;
	readonly name: string;
	readonly script: readonly ScriptedTurn[];
	readonly specTurns: readonly ConversationTurn[];
	readonly recordingEndMs: number;
}

// The conversations the developer would have authored. interrupt_after_ms marks
// the barge-in; the agent turn it interrupts must yield within 500ms, and the
// recovery turn must mention the corrected city.
const CONVERSATIONS: readonly ScriptedConversation[] = [
	{
		key: "barge-in",
		name: "user corrects destination mid-answer",
		script: BARGE_IN_SCRIPT,
		recordingEndMs: 8200,
		specTurns: [
			{ role: "user", text: BARGE_IN_SCRIPT[0]?.transcript ?? "", assertions: [] },
			{ role: "agent", assertions: [{ kind: "yielded_within_ms", max_ms: 500 }] },
			{
				role: "user",
				text: BARGE_IN_SCRIPT[2]?.transcript ?? "",
				interrupt_after_ms: 2000,
				assertions: [],
			},
			{
				role: "agent",
				assertions: [
					{ kind: "contains", text: "Berlin", case_insensitive: true },
					{ kind: "tool_called", name: "book_flight" },
				],
			},
		],
	},
	{
		key: "lookup",
		name: "user asks when their flight leaves",
		script: LOOKUP_SCRIPT,
		recordingEndMs: 3400,
		specTurns: [
			{ role: "user", text: LOOKUP_SCRIPT[0]?.transcript ?? "", assertions: [] },
			{
				role: "agent",
				assertions: [
					{ kind: "contains", text: "6pm", case_insensitive: true },
					{ kind: "tool_called", name: "get_flight_status" },
				],
			},
		],
	},
];

const ALL_SCRIPTED_TURNS: readonly ScriptedTurn[] = CONVERSATIONS.flatMap((c) => c.script);

/**
 * The tool each agent turn calls, per conversation. Named per script so the
 * seeded trace reads as the agent that produced the transcript rather than as
 * generic filler, and referenced by the `tool_called` assertion in the spec
 * above — which is the point: the trace is load-bearing, so a regeneration that
 * silently stopped persisting spans would fail the fixture's own assertions
 * instead of quietly producing an empty span tree.
 */
const TOOL_BY_CONVERSATION: Readonly<Record<string, string>> = {
	"barge-in": "book_flight",
	lookup: "get_flight_status",
};

/** Tool arguments per agent turn index — the destination the turn commits to. */
const TOOL_ARGS_BY_TURN: Readonly<Record<string, Readonly<Record<number, string>>>> = {
	"barge-in": { 1: "Paris", 3: "Berlin" },
	lookup: { 1: "LH1042" },
};

/**
 * Five configurations, so the comparison view has a realistic spread on a fresh
 * checkout. `agentDelayMs` shifts only the *start* of each agent turn, never its
 * end: that moves `agent_response_ms` (the number the configs differ on) while
 * leaving the barge-in overlap — and therefore `yield_ms` and the
 * `yielded_within_ms` assertion — identical. Every run passes; they differ only
 * on how quickly the agent gets going.
 *
 * `temperature` is a float on purpose: it exercises the run-config canonicalizer
 * that the conversation one can't handle.
 */
interface RunVariant {
	readonly key: string;
	readonly configName: string;
	readonly config: Record<string, string | number>;
	readonly agentDelayMs: number;
}

const RUN_VARIANTS: readonly RunVariant[] = [
	{ key: "baseline", configName: "baseline", config: { model: "gpt-4o" }, agentDelayMs: 0 },
	{
		key: "fast-follow",
		configName: "fast-follow",
		config: { model: "gemini-2.5-flash" },
		agentDelayMs: -250,
	},
	{
		key: "precise",
		configName: "precise",
		config: { model: "gpt-4o", temperature: 0.2 },
		agentDelayMs: 120,
	},
	{ key: "mini", configName: "mini", config: { model: "gpt-4o-mini" }, agentDelayMs: -100 },
	{
		key: "flash-tuned",
		configName: "flash-tuned",
		config: { model: "gemini-2.5-flash", temperature: 0.9, top_p: 0.8 },
		agentDelayMs: 350,
	},
];

/**
 * One row per replay, with a hand-assigned id so the fixture stays stable across
 * regenerations. Only two configs ran the barge-in conversation: that partial
 * coverage is what the compare view's fair-comparison warning is for, so the
 * fixture has to contain a case that triggers it.
 *
 * `...0001` is the barge-in run this fixture has always held and its WAV is
 * byte-identical — the inspector's canonical example is unchanged. `...0002` is
 * new: a second run of that same conversation under `fast-follow`, so the
 * barge-in conversation has more than one config to compare.
 */
interface SeedReplay {
	readonly replayId: string;
	readonly variantKey: string;
	readonly conversationKey: string;
	readonly startedAt: string;
}

const SEED_REPLAYS: readonly SeedReplay[] = [
	{
		replayId: "ba9e1000-0000-4000-8000-000000000001",
		variantKey: "baseline",
		conversationKey: "barge-in",
		startedAt: "2026-07-01T12:00:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000002",
		variantKey: "fast-follow",
		conversationKey: "barge-in",
		startedAt: "2026-07-01T12:05:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000003",
		variantKey: "baseline",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:00:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000004",
		variantKey: "fast-follow",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:05:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000005",
		variantKey: "precise",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:10:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000006",
		variantKey: "mini",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:15:00.000Z",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000007",
		variantKey: "flash-tuned",
		conversationKey: "lookup",
		startedAt: "2026-07-02T09:20:00.000Z",
	},
];

/** Agent turns start `agentDelayMs` earlier/later; their ends never move. */
function scriptFor(script: readonly ScriptedTurn[], agentDelayMs: number): readonly ScriptedTurn[] {
	if (agentDelayMs === 0) return script;
	return script.map((turn) =>
		turn.role === "agent" ? { ...turn, startMs: turn.startMs + agentDelayMs } : turn,
	);
}

function buildWav(script: readonly ScriptedTurn[], recordingEndMs: number): StereoWav {
	const totalSamples = Math.round((recordingEndMs / 1000) * SAMPLE_RATE);
	const left = new Int16Array(totalSamples);
	const right = new Int16Array(totalSamples);
	for (const turn of script) {
		writeTone(turn.role === "user" ? left : right, turn);
	}
	return { sampleRate: SAMPLE_RATE, bitsPerSample: 16, left, right };
}

function writeTone(channel: Int16Array, turn: ScriptedTurn): void {
	const start = Math.round((turn.startMs / 1000) * SAMPLE_RATE);
	const end = Math.round((turn.endMs / 1000) * SAMPLE_RATE);
	for (let i = start; i < end; i++) {
		channel[i] = Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * turn.amplitude);
	}
}

/**
 * The trace the dev's agent would have emitted, as OTLP.
 *
 * Pushed through the REAL receiver (`ingestOtlpTraces`), so the vocabulary
 * registry, the `tool_calls` / `model_usage` extraction, and the read-time turn
 * attribution all run exactly as they do in production — same reason the analyze
 * chain runs for real rather than having its rows written by hand.
 *
 * Offsets are relative to the same variant-shifted script that produced the WAV,
 * and the recording origin is the replay's `startedAt`, so a span's wall-clock
 * maps to the intended audio offset without a clock read. Ids are derived from
 * the replay ordinal, so a regeneration stays byte-identical.
 *
 * Spans are ingested BEFORE the analyze chain, which is both faithful (the
 * agent emits them while the run is happening, long before anyone asks for
 * analysis) and a live check of the documented design: the receiver stores no
 * turn association, so it must not care that `replay_turns` is still empty.
 */
interface SeededSpan {
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly startMs: number;
	readonly endMs: number;
	readonly attributes: Readonly<Record<string, string | number>>;
}

/** `openai` / `google-gemini` from the variant's model id — no cast, no guessing. */
function providerFor(model: string): "openai" | "google-gemini" {
	if (model.startsWith("gpt")) return "openai";
	if (model.startsWith("gemini")) return "google-gemini";
	throw new Error(`seed-snapshot: no provider mapping for model "${model}"`);
}

function modelOf(variant: RunVariant): string {
	const { model } = variant.config;
	if (typeof model !== "string") {
		throw new Error(`seed-snapshot: run variant "${variant.key}" has no string model`);
	}
	return model;
}

/** Hex ids, derived so they're stable across regenerations. */
function seededSpanId(replayOrdinal: number, turnIdx: number, slot: number): string {
	const parts = [replayOrdinal, turnIdx, slot].map((n) => n.toString(16).padStart(2, "0"));
	return `5eed${parts.join("")}0000`.slice(0, 16);
}

function seededTraceId(replayOrdinal: number): string {
	return `5eed7ace${replayOrdinal.toString(16).padStart(4, "0")}`.padEnd(32, "0");
}

function buildSeededTrace(
	conversation: ScriptedConversation,
	variant: RunVariant,
	script: readonly ScriptedTurn[],
	replayOrdinal: number,
): readonly SeededSpan[] {
	const model = modelOf(variant);
	const provider = providerFor(model);
	const toolName = TOOL_BY_CONVERSATION[conversation.key];
	if (toolName === undefined) {
		throw new Error(`seed-snapshot: no tool name for conversation "${conversation.key}"`);
	}
	const spans: SeededSpan[] = [];

	script.forEach((turn, turnIdx) => {
		const turnSpanId = seededSpanId(replayOrdinal, turnIdx, 0);
		spans.push({
			spanId: turnSpanId,
			name: "xray.turn",
			startMs: turn.startMs,
			endMs: turn.endMs,
			attributes: { "xray.turn.role": turn.role, "xray.turn.index": turnIdx },
		});
		if (turn.role !== "agent") return;

		// The model call straddles the start of the agent's speech: it begins in
		// the gap the agent was thinking in (the narrowest gap any variant
		// produces is 150ms, so -80 stays inside this turn's derived window) and
		// runs just past the first audio frame.
		const chatSpanId = seededSpanId(replayOrdinal, turnIdx, 1);
		spans.push({
			spanId: chatSpanId,
			parentSpanId: turnSpanId,
			name: "agent_turn",
			startMs: turn.startMs - 80,
			endMs: turn.startMs + 200,
			attributes: {
				"gen_ai.operation.name": "chat",
				"gen_ai.system": provider,
				"gen_ai.request.model": model,
				"gen_ai.response.model": model,
				// Distinct per turn so the inspector's token bars aren't all identical.
				"gen_ai.usage.input_tokens": 480 + turnIdx * 122,
				"gen_ai.usage.output_tokens": 32 + turnIdx * 7,
				"gen_ai.response.time_to_first_chunk": 0.14 + turnIdx / 100,
			},
		});

		const destination = TOOL_ARGS_BY_TURN[conversation.key]?.[turnIdx];
		if (destination === undefined) return;
		spans.push({
			spanId: seededSpanId(replayOrdinal, turnIdx, 2),
			parentSpanId: chatSpanId,
			name: "execute_tool",
			startMs: turn.startMs + 40,
			endMs: turn.startMs + 122,
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": toolName,
				// The same keys examples/livekit-voice-agent/agent/main.py sets.
				"gen_ai.tool.arguments": JSON.stringify({ destination, cabin: "economy" }),
				"gen_ai.tool.result": JSON.stringify({ confirmation: "QK4T2Z", destination }),
			},
		});

		// One Langfuse observation, so a fresh checkout shows the third recognized
		// vocabulary in the span tree and not just `xray.*` + GenAI semconv.
		if (turnIdx !== script.length - 1) return;
		spans.push({
			spanId: seededSpanId(replayOrdinal, turnIdx, 3),
			parentSpanId: chatSpanId,
			name: "booking_policy_check",
			startMs: turn.startMs + 260,
			endMs: turn.startMs + 282,
			attributes: {
				"langfuse.observation.type": "span",
				"langfuse.observation.name": "booking_policy_check",
				"langfuse.observation.metadata.rebook_window_min": "15",
			},
		});
	});

	return spans;
}

function otlpRequestFor(
	replayId: string,
	replayOrdinal: number,
	startedAt: string,
	spans: readonly SeededSpan[],
): ExportTraceServiceRequest {
	const originMs = Date.parse(startedAt);
	const nanos = (offsetMs: number): string => String((originMs + offsetMs) * 1_000_000);
	const payload = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "xray.replay.id", value: { stringValue: replayId } },
						{ key: "service.name", value: { stringValue: "snapshot-voice-agent" } },
					],
				},
				scopeSpans: [
					{
						scope: { name: "xray.sdk" },
						spans: spans.map((span) => ({
							traceId: seededTraceId(replayOrdinal),
							spanId: span.spanId,
							...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
							name: span.name,
							startTimeUnixNano: nanos(span.startMs),
							endTimeUnixNano: nanos(span.endMs),
							attributes: Object.entries(span.attributes).map(([key, value]) => ({
								key,
								value: typeof value === "string" ? { stringValue: value } : { doubleValue: value },
							})),
						})),
					},
				],
			},
		],
	};
	// Parsed with the receiver's own schema rather than hand-satisfying its
	// inferred type: if the wire contract changes, this fails here instead of
	// producing a fixture the real endpoint would have rejected.
	return v.parse(ExportTraceServiceRequestSchema, payload);
}

/**
 * Maps a turn's audio slice back to its scripted line by peak amplitude — each
 * turn was synthesized at a distinct amplitude, and silence between turns is
 * zero, so the peak of a single-channel slice uniquely identifies the turn.
 */
function makeScriptedTranscription(): TranscriptionProvider {
	return {
		name: "snapshot-scripted",
		model: "peak-amplitude",
		transcribe(input): Promise<TranscriptionResult> {
			let peak = 0;
			for (const sample of input.audio) {
				const magnitude = Math.abs(sample);
				if (magnitude > peak) peak = magnitude;
			}
			const turn = ALL_SCRIPTED_TURNS.reduce((best, candidate) =>
				Math.abs(candidate.amplitude - peak) < Math.abs(best.amplitude - peak) ? candidate : best,
			);
			const durationMs = Math.round((input.audio.length / input.sampleRate) * 1000);
			return Promise.resolve({ text: turn.transcript, language: "en", durationMs, words: null });
		},
	};
}

// evaluate-replay requires a judge provider, but neither conversation declares
// judges, so this is never invoked — it throws loudly if that ever changes.
const UNUSED_JUDGE_PROVIDER: JudgeProvider = {
	name: "snapshot-no-judge",
	model: "none",
	judge() {
		throw new Error("seed-snapshot: neither seeded conversation declares judges");
	},
};

function requireVariant(key: string): RunVariant {
	const variant = RUN_VARIANTS.find((candidate) => candidate.key === key);
	if (variant === undefined) throw new Error(`seed-snapshot: unknown run variant "${key}"`);
	return variant;
}

function requireConversation(key: string): ScriptedConversation {
	const conversation = CONVERSATIONS.find((c) => c.key === key);
	if (conversation === undefined) throw new Error(`seed-snapshot: unknown conversation "${key}"`);
	return conversation;
}

async function main(): Promise<void> {
	// Start from a clean slate so a regeneration can't leave stale rows or a
	// mismatched WAL behind.
	for (const suffix of ["", "-shm", "-wal"]) {
		await rm(`${DB_PATH}${suffix}`, { force: true });
	}
	await rm(AUDIO_ROOT, { recursive: true, force: true });
	await mkdir(dirname(DB_PATH), { recursive: true });

	const store = openStore({ path: DB_PATH });
	try {
		const hashes = new Map<string, string>();
		for (const conversation of CONVERSATIONS) {
			const { json: turnsJson, hash } = await canonicalizeAndHashSpec(conversation.specTurns, []);
			ensureConversation(store.db, {
				hash,
				name: conversation.name,
				turnsJson,
				now: SEED_REPLAYS[0]?.startedAt ?? "",
			});
			hashes.set(conversation.key, hash);
		}

		for (const seed of SEED_REPLAYS) {
			const hash = hashes.get(seed.conversationKey);
			if (hash === undefined) {
				throw new Error(`seed-snapshot: no hash for conversation "${seed.conversationKey}"`);
			}
			await seedReplay(store, hash, seed);
		}

		printSummary(store);

		// Fold the WAL into the main db file: only `snapshot/xray.db` is
		// committed (the -wal/-shm siblings are gitignored), so every row must
		// live in the main file before we close.
		store.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
	} finally {
		store.close();
	}
}

async function seedReplay(
	store: ReturnType<typeof openStore>,
	conversationHash: string,
	seed: SeedReplay,
): Promise<void> {
	const { replayId } = seed;
	const variant = requireVariant(seed.variantKey);
	const conversation = requireConversation(seed.conversationKey);

	createReplay(
		store,
		{
			conversation_hash: conversationHash,
			run_config: variant.config,
			run_config_name: variant.configName,
		},
		{ id: replayId, now: () => seed.startedAt },
	);

	const wavPath = join(AUDIO_ROOT, replayId, "replay.wav");
	await mkdir(dirname(wavPath), { recursive: true });
	const script = scriptFor(conversation.script, variant.agentDelayMs);
	await writeFile(wavPath, writeStereoWav(buildWav(script, conversation.recordingEndMs)));

	store.db
		.update(replays)
		.set({
			audioPath: `${replayId}/replay.wav`,
			recordingStartedAt: seed.startedAt,
			lifecycleState: "analyzing",
			analysisStep: "vad",
		})
		.where(eq(replays.id, replayId))
		.run();

	const replayOrdinal = SEED_REPLAYS.indexOf(seed) + 1;
	const trace = buildSeededTrace(conversation, variant, script, replayOrdinal);
	const { result } = ingestOtlpTraces(
		store,
		otlpRequestFor(replayId, replayOrdinal, seed.startedAt, trace),
	);
	// A rejected span means a vocabulary stopped recognizing what we emit; the
	// fixture would then ship an empty span tree, which is exactly the silence
	// this fixture exists to prevent.
	if (result.rejectedSpans !== 0 || result.persistedSpans !== trace.length) {
		throw new Error(
			`seed-snapshot: ${replayId} expected ${trace.length} spans persisted, got ${result.persistedSpans} (rejected ${result.rejectedSpans})`,
		);
	}

	// Drive the three chain stages in order. Each normally enqueues the next
	// on the job queue; here the fake runner swallows that and we call the
	// next stage directly, so the whole pipeline runs in one process.
	const events = makeReplayEvents();
	const runner = makeFakeJobRunner();
	await makeAnalyzeProcessor(
		store,
		AUDIO_ROOT,
		events,
		runner,
		makeScriptedTranscription(),
	)({ replayId });
	await makeCalculateMetricsProcessor(store, events, runner)({ replayId });
	await makeEvaluateReplayProcessor(store, events, UNUSED_JUDGE_PROVIDER)({ replayId });

	pinGeneratedTimestamps(store, seed, conversation);
}

/**
 * The three processors stamp the real wall clock into `finished_at` and
 * `evaluated_at` — they take no clock to inject. Left alone, a regeneration
 * rewrites those columns (a binary diff with no logical change) and the
 * inspector shows a replay that started in July and finished whenever the
 * fixture was last rebuilt. Overwriting them here, at the seam where the run is
 * already complete, keeps the whole fixture derived from `startedAt` and makes
 * the `.db` genuinely byte-identical run to run.
 */
function pinGeneratedTimestamps(
	store: ReturnType<typeof openStore>,
	seed: SeedReplay,
	conversation: ScriptedConversation,
): void {
	const finishedAt = new Date(
		Date.parse(seed.startedAt) + conversation.recordingEndMs + 1_200,
	).toISOString();
	store.db.update(replays).set({ finishedAt }).where(eq(replays.id, seed.replayId)).run();
	store.db
		.update(assertionResults)
		.set({ evaluatedAt: finishedAt })
		.where(eq(assertionResults.replayId, seed.replayId))
		.run();
	store.db
		.update(replayEvaluations)
		.set({ evaluatedAt: finishedAt })
		.where(eq(replayEvaluations.replayId, seed.replayId))
		.run();
}

function printSummary(store: ReturnType<typeof openStore>): void {
	for (const seed of SEED_REPLAYS) {
		const { replayId } = seed;
		const variant = requireVariant(seed.variantKey);
		const replay = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		const metrics = store.db
			.select()
			.from(replayMetrics)
			.where(eq(replayMetrics.replayId, replayId))
			.all();
		const outcomes = store.db
			.select()
			.from(assertionResults)
			.where(eq(assertionResults.replayId, replayId))
			.all();
		const evaluation = store.db
			.select()
			.from(replayEvaluations)
			.where(eq(replayEvaluations.replayId, replayId))
			.get();

		console.info(
			`snapshot replay ${replayId} (${variant.configName} / ${seed.conversationKey}) → ${replay?.lifecycleState}`,
		);
		const responses = metrics
			.map((m) => m.agentResponseMs)
			.filter((ms): ms is number => ms !== null);
		console.info(`  agent_response_ms: ${responses.join(", ") || "(none)"}`);
		const interrupted = metrics.find((m) => m.yieldMs !== null);
		console.info(`  yield_ms: ${interrupted?.yieldMs ?? "(none)"}`);
		for (const outcome of outcomes) {
			console.info(`  turn ${outcome.turnIdx} ${outcome.kind}: ${outcome.status}`);
		}
		console.info(`  passed: ${evaluation?.passed}`);
	}
}

await main();
