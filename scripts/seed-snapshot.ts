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
 * Nothing here is random or clock-dependent, so the fixture's CONTENT is
 * reproducible anywhere: `sqlite3 snapshot/xray.db .dump | shasum` is stable
 * across machines. Two things had to be forced for even that much — the
 * wall-clock columns the job processors stamp (`pinGeneratedTimestamps`) and
 * SQLite's own file change counter (`promoteDeterministicDb`).
 *
 * The BYTES are only stable per platform, and this is measured, not assumed:
 * the header records the writing library's `SQLITE_VERSION_NUMBER` and its
 * reserved-bytes-per-page, and `bun:sqlite` links the OS SQLite on macOS
 * (3.51.0) while bundling its own on Linux (3.53.0). The same pinned Bun on the
 * two platforms produces ~9.5KB of differing bytes for a `.dump`-identical
 * fixture — so regenerating inside the dev container and regenerating on a Mac
 * host legitimately disagree.
 *
 * So: a `snapshot/xray.db` diff in a PR that didn't touch this script is worth
 * looking at, but check `.dump` before calling it a real change — a whole-file
 * hash difference on its own may only mean the author regenerated on a
 * different OS.
 * Run: `bun run scripts/seed-snapshot.ts`.
 *
 * The one concession to "authentic": transcripts are scripted rather than
 * produced by a real STT provider (there's no key offline). Each turn's audio
 * carries a distinct amplitude so the stand-in provider can map a slice back to
 * its line — VAD, turn derivation, metrics, and assertions all run for real.
 */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { eq, sql } from "drizzle-orm";

import { writeStereoWav } from "@/server/audio/audio.wav.ts";
import {
	canonicalizeAndHashSpec,
	ensureConversation,
} from "@/server/conversations/conversations.service.ts";
import { makeAnalyzeProcessor } from "@/server/jobs/analyze-replay/analyze-replay.processor.ts";
import { makeCalculateMetricsProcessor } from "@/server/jobs/calculate-metrics/calculate-metrics.processor.ts";
import { makeEvaluateReplayProcessor } from "@/server/jobs/evaluate-replay/evaluate-replay.processor.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import type { JudgeProvider } from "@/server/judges/judges.types.ts";
import { ingestOtlpTraces } from "@/server/otlp/otlp.service.ts";
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

import { buildWav, scriptFor } from "./seed-snapshot.audio.ts";
import type { SeedReplay } from "./seed-snapshot.fixture.ts";
import {
	ALL_SCRIPTED_TURNS,
	CONVERSATIONS,
	DECLARED_ASSERTIONS_BY_CONVERSATION,
	requireConversation,
	requireVariant,
	SEED_REPLAYS,
} from "./seed-snapshot.fixture.ts";
import { buildSeededTrace, expectedExtractions, otlpRequestFor } from "./seed-snapshot.trace.ts";
import type { ScriptedConversation } from "./seed-snapshot.types.ts";
import { assertExtractedRows, assertReplayIsGreen } from "./seed-snapshot.verify.ts";

const SNAPSHOT_DIR = new URL("../snapshot", import.meta.url).pathname;
const DB_PATH = join(SNAPSHOT_DIR, "xray.db");
// VACUUM INTO refuses to overwrite, so the deterministic copy is built beside
// the working file and renamed over it once the run is complete.
const DB_TMP_PATH = join(SNAPSHOT_DIR, "xray.db.tmp");
const AUDIO_ROOT = join(SNAPSHOT_DIR, "audio");

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

async function main(): Promise<void> {
	// Start from a clean slate so a regeneration can't leave stale rows or a
	// mismatched WAL behind. The `.tmp` copy is cleared too: `VACUUM INTO`
	// refuses an existing target, so a run that died between the vacuum and the
	// rename would otherwise block every run after it.
	for (const path of [DB_PATH, DB_TMP_PATH]) {
		for (const suffix of ["", "-shm", "-wal"]) {
			await rm(`${path}${suffix}`, { force: true });
		}
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
		for (const seed of SEED_REPLAYS) {
			assertReplayIsGreen(
				store.db,
				seed.replayId,
				DECLARED_ASSERTIONS_BY_CONVERSATION[seed.conversationKey],
			);
		}

		// Fold the WAL into the main db file AND normalize the header: only
		// `snapshot/xray.db` is committed (the -wal/-shm siblings are
		// gitignored), so every row must live in the main file before we close.
		store.db.run(sql`VACUUM INTO ${DB_TMP_PATH}`);
	} finally {
		store.close();
	}

	await promoteDeterministicDb();
}

/**
 * A `wal_checkpoint` alone leaves SQLite's file change counter (header bytes
 * 24-27, mirrored at 92-95) reflecting how many write transactions this run
 * happened to commit — the one part of the fixture that isn't derived from
 * `startedAt`, and enough to make two logically identical runs hash
 * differently. `VACUUM INTO` writes a fresh file whose header is a pure
 * function of the content; re-opening the copy puts it back in WAL mode, which
 * is what the server always runs, so the first `openStore` on a fresh clone
 * doesn't rewrite two bytes of a committed artifact.
 */
async function promoteDeterministicDb(): Promise<void> {
	const copy = openStore({ path: DB_TMP_PATH });
	try {
		copy.db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
	} finally {
		copy.close();
	}
	// Only the siblings are removed: `rename` replaces the main file atomically,
	// so this step never leaves the fixture missing from disk. (The run as a whole
	// still does — `main` unlinks it up front to start from a clean slate.)
	for (const path of [DB_PATH, DB_TMP_PATH]) {
		for (const suffix of ["-shm", "-wal"]) {
			await rm(`${path}${suffix}`, { force: true });
		}
	}
	await rename(DB_TMP_PATH, DB_PATH);
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
	// Recognized isn't the same as extracted. The expected counts never come from
	// the spans just built, so a drifted attribute can't move the expectation
	// along with the extraction it broke. (`modelUsage` is the script's agent
	// turns; `toolCalls` is the trace builder's per-turn argument table, so a
	// deleted entry there does move both — `fixture.test.ts` pins those counts.)
	assertExtractedRows(store.db, {
		replayId,
		spans: trace.length,
		...expectedExtractions(conversation, script),
	});

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
