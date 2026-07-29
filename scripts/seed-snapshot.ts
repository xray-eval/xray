/**
 * Regenerate the committed `snapshot/` fixture from scratch.
 *
 * It builds a scripted barge-in conversation, synthesizes a stereo WAV in which
 * the user talks over the agent, and runs it through the REAL analyze pipeline
 * (VAD → per-turn metrics → assertion evaluation). The result — overlapping
 * audio, a genuine `yield_ms` metric, and a passing `yielded_within_ms`
 * assertion — is written to `snapshot/xray.db` + `snapshot/audio/` so a
 * developer can open the inspector and see an authentic interruption without a
 * live agent or any provider API keys.
 *
 * Nothing here is random or clock-dependent, so re-running produces a
 * byte-identical fixture. Run: `bun run scripts/seed-snapshot.ts`.
 *
 * The one concession to "authentic": transcripts are scripted rather than
 * produced by a real STT provider (there's no key offline). Each turn's audio
 * carries a distinct amplitude so the stand-in provider can map a slice back to
 * its line — VAD, turn derivation, metrics, and assertions all run for real.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { eq, sql } from "drizzle-orm";

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

const RECORDING_STARTED_AT = "2026-07-01T12:00:00.000Z";
const CONVERSATION_NAME = "user corrects destination mid-answer";

/**
 * The same conversation run under two configurations, so the config-comparison
 * view has something real to show on a fresh checkout.
 *
 * `agentDelayMs` shifts only the *start* of each agent turn, never its end:
 * that moves `agent_response_ms` (the number the two configs differ on) while
 * leaving the barge-in overlap — and therefore `yield_ms` and the
 * `yielded_within_ms` assertion — identical. Both runs pass; one is simply
 * quicker off the mark.
 *
 * The first variant is byte-identical to the single replay this fixture used
 * to hold, so the inspector's canonical example is unchanged.
 */
interface RunVariant {
	readonly replayId: string;
	readonly agentDelayMs: number;
	readonly config: Record<string, string>;
	readonly configName: string;
}

const RUN_VARIANTS: readonly RunVariant[] = [
	{
		replayId: "ba9e1000-0000-4000-8000-000000000001",
		agentDelayMs: 0,
		config: { model: "gpt-4o" },
		configName: "baseline",
	},
	{
		replayId: "ba9e1000-0000-4000-8000-000000000002",
		agentDelayMs: -250,
		config: { model: "gemini-2.5-flash" },
		configName: "fast-follow",
	},
];

const SAMPLE_RATE = 48_000;
const TONE_HZ = 200;

// One line per turn. The distinct amplitude doubles as the marker the
// stand-in transcription provider reads back to recover the line.
interface ScriptedTurn {
	readonly role: "user" | "agent";
	readonly startMs: number;
	readonly endMs: number;
	readonly amplitude: number;
	readonly transcript: string;
}

const SCRIPT: readonly ScriptedTurn[] = [
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
const RECORDING_END_MS = 8200;

// The conversation the developer would have authored. interrupt_after_ms marks
// the barge-in; the agent turn it interrupts must yield within 500ms, and the
// recovery turn must mention the corrected city.
const SPEC_TURNS: readonly ConversationTurn[] = [
	{ role: "user", text: SCRIPT[0]?.transcript ?? "", assertions: [] },
	{ role: "agent", assertions: [{ kind: "yielded_within_ms", max_ms: 500 }] },
	{ role: "user", text: SCRIPT[2]?.transcript ?? "", interrupt_after_ms: 2000, assertions: [] },
	{ role: "agent", assertions: [{ kind: "contains", text: "Berlin", case_insensitive: true }] },
];

/** Agent turns start `agentDelayMs` earlier/later; their ends never move. */
function scriptFor(agentDelayMs: number): readonly ScriptedTurn[] {
	if (agentDelayMs === 0) return SCRIPT;
	return SCRIPT.map((turn) =>
		turn.role === "agent" ? { ...turn, startMs: turn.startMs + agentDelayMs } : turn,
	);
}

function buildBargeInWav(script: readonly ScriptedTurn[]): StereoWav {
	const totalSamples = Math.round((RECORDING_END_MS / 1000) * SAMPLE_RATE);
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
			const turn = SCRIPT.reduce((best, candidate) =>
				Math.abs(candidate.amplitude - peak) < Math.abs(best.amplitude - peak) ? candidate : best,
			);
			const durationMs = Math.round((input.audio.length / input.sampleRate) * 1000);
			return Promise.resolve({ text: turn.transcript, language: "en", durationMs, words: null });
		},
	};
}

// evaluate-replay requires a judge provider, but the conversation declares no
// judges, so this is never invoked — it throws loudly if that ever changes.
const UNUSED_JUDGE_PROVIDER: JudgeProvider = {
	name: "snapshot-no-judge",
	model: "none",
	judge() {
		throw new Error("seed-snapshot: the barge-in conversation declares no judges");
	},
};

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
		const now = RECORDING_STARTED_AT;
		const { json: turnsJson, hash } = await canonicalizeAndHashSpec(SPEC_TURNS, []);
		ensureConversation(store.db, { hash, name: CONVERSATION_NAME, turnsJson, now });

		for (const variant of RUN_VARIANTS) {
			await seedVariant(store, hash, variant);
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

async function seedVariant(
	store: ReturnType<typeof openStore>,
	conversationHash: string,
	variant: RunVariant,
): Promise<void> {
	const { replayId } = variant;
	createReplay(
		store,
		{
			conversation_hash: conversationHash,
			run_config: variant.config,
			run_config_name: variant.configName,
		},
		{ id: replayId, now: () => RECORDING_STARTED_AT },
	);

	const wavPath = join(AUDIO_ROOT, replayId, "replay.wav");
	await mkdir(dirname(wavPath), { recursive: true });
	await writeFile(wavPath, writeStereoWav(buildBargeInWav(scriptFor(variant.agentDelayMs))));

	store.db
		.update(replays)
		.set({
			audioPath: `${replayId}/replay.wav`,
			recordingStartedAt: RECORDING_STARTED_AT,
			lifecycleState: "analyzing",
			analysisStep: "vad",
		})
		.where(eq(replays.id, replayId))
		.run();

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
}

function printSummary(store: ReturnType<typeof openStore>): void {
	for (const variant of RUN_VARIANTS) {
		const { replayId } = variant;
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

		console.info(`snapshot replay ${replayId} (${variant.configName}) → ${replay?.lifecycleState}`);
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
