import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { eq } from "drizzle-orm";

import { makeTempAudioRoot, seedReplayForAudio } from "@/server/audio/audio.test-utils.ts";
import type { StereoWav } from "@/server/audio/audio.types.ts";
import { writeStereoWav } from "@/server/audio/audio.wav.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import { makeReplayEvents } from "@/server/replays/replays.events.ts";
import { replays, replayTurns, speechSegments, turnTranscripts } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";
import { makeFakeTranscriptionProvider } from "@/server/transcription/transcription.test-utils.ts";

import { makeAnalyzeProcessor } from "./analyze-replay.processor.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const SAMPLE_RATE = 48_000;

interface ToneBlock {
	durationMs: number;
	voiced: boolean;
	/** Sine amplitude for voiced blocks. Default 15_000 trips the VAD;
	 *  pass a sub-threshold value (< ~3_162 ⇒ mean energy < 5e6) to lay
	 *  down real audio the energy VAD does NOT detect. */
	amplitude?: number;
}

function makeStereo(parts: { userBlocks: ToneBlock[]; agentBlocks: ToneBlock[] }): StereoWav {
	const userSamples = parts.userBlocks.reduce(
		(sum, b) => sum + Math.floor((SAMPLE_RATE * b.durationMs) / 1000),
		0,
	);
	const agentSamples = parts.agentBlocks.reduce(
		(sum, b) => sum + Math.floor((SAMPLE_RATE * b.durationMs) / 1000),
		0,
	);
	const totalSamples = Math.max(userSamples, agentSamples);

	const left = new Int16Array(totalSamples);
	const right = new Int16Array(totalSamples);
	fillBlocks(left, parts.userBlocks, 200);
	fillBlocks(right, parts.agentBlocks, 200);
	return { sampleRate: SAMPLE_RATE, bitsPerSample: 16, left, right };
}

function fillBlocks(out: Int16Array, blocks: ToneBlock[], freqHz: number): void {
	let cursor = 0;
	for (const block of blocks) {
		const samples = Math.floor((SAMPLE_RATE * block.durationMs) / 1000);
		if (block.voiced) {
			const amplitude = block.amplitude ?? 15_000;
			for (let i = 0; i < samples; i++) {
				out[cursor + i] = Math.round(
					Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * amplitude,
				);
			}
		}
		cursor += samples;
	}
}

let store: Store;
let audio: ReturnType<typeof makeTempAudioRoot>;

beforeEach(() => {
	store = makeTempStore();
	audio = makeTempAudioRoot();
});

afterEach(() => {
	store.close();
	audio.dispose();
});

function makeProcessor() {
	const runner = makeFakeJobRunner();
	const transcription = makeFakeTranscriptionProvider({ text: "ok" });
	const processor = makeAnalyzeProcessor(
		store,
		audio.path,
		makeReplayEvents(),
		runner,
		transcription,
	);
	return { processor, runner, transcription };
}

describe("analyze-replay processor", () => {
	it("populates segments + turns, writes transcripts, leaves replay in 'analyzing' with step='transcribe', enqueues calculate-metrics", async () => {
		const { replayId } = await seedReplayForAudio(store);
		const wav = makeStereo({
			userBlocks: [
				{ durationMs: 200, voiced: false },
				{ durationMs: 800, voiced: true },
				{ durationMs: 2000, voiced: false },
			],
			agentBlocks: [
				{ durationMs: 1200, voiced: false },
				{ durationMs: 1200, voiced: true },
			],
		});
		const wavBytes = writeStereoWav(wav);
		const relPath = `${replayId}/replay.wav`;
		const absPath = join(audio.path, relPath);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, wavBytes);
		store.db
			.update(replays)
			.set({ audioPath: relPath, lifecycleState: "analyzing", analysisStep: "vad" })
			.where(eq(replays.id, replayId))
			.run();

		const { processor, runner } = makeProcessor();
		const result = await processor({ replayId });

		expect(result.ok).toBe(true);
		expect(result.segmentsWritten).toBeGreaterThan(0);
		expect(result.turnsWritten).toBeGreaterThan(0);
		expect(result.transcribedTurns).toBeGreaterThan(0);

		const segments = store.db
			.select()
			.from(speechSegments)
			.where(eq(speechSegments.replayId, replayId))
			.all();
		expect(segments.length).toBeGreaterThan(0);

		const turns = store.db
			.select()
			.from(replayTurns)
			.where(eq(replayTurns.replayId, replayId))
			.all();
		expect(turns.length).toBeGreaterThan(0);
		expect(turns.map((t) => t.idx).sort()).toEqual([...turns.keys()]);

		const transcripts = store.db
			.select()
			.from(turnTranscripts)
			.where(eq(turnTranscripts.replayId, replayId))
			.all();
		expect(transcripts.length).toBe(turns.length);
		for (const t of transcripts) expect(t.text).toBe("ok");

		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.lifecycleState).toBe("analyzing");
		expect(after?.analysisStep).toBe("transcribe");

		expect(runner.enqueued).toEqual([{ name: "calculate-metrics", payload: { replayId } }]);
	});

	it("slices each turn's full attribution window, not just the VAD voiced extent", async () => {
		// Regression from a real deployment: the agent's actual reply sat
		// inside the turn's window but the slice handed to the transcription
		// provider was pinned to the VAD voiced extent, so it carried only
		// pre-reply audio, `turn_transcripts.text` came back "", and the
		// judge scored a perfect answer as "offers no help at all".
		//
		// Model that here: the agent turn's detected voice is a short loud
		// blip at 1.5s, and the actual reply is a quiet 2s tone at 4.0–6.0s —
		// below the VAD energy threshold (amplitude 2_500 ⇒ mean energy
		// ≈3.1e6 < 5e6), so no speech segment marks it. The slice must still
		// cover it: each turn owns its tiling attribution window, with the
		// last window extended to the end of the recording.
		const { replayId } = await seedReplayForAudio(store);
		const wav = makeStereo({
			userBlocks: [
				{ durationMs: 1000, voiced: true },
				{ durationMs: 5500, voiced: false },
			],
			agentBlocks: [
				{ durationMs: 1500, voiced: false },
				{ durationMs: 300, voiced: true },
				{ durationMs: 2200, voiced: false },
				{ durationMs: 2000, voiced: true, amplitude: 2_500 },
				{ durationMs: 500, voiced: false },
			],
		});
		const wavBytes = writeStereoWav(wav);
		const relPath = `${replayId}/replay.wav`;
		const absPath = join(audio.path, relPath);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, wavBytes);
		store.db
			.update(replays)
			.set({ audioPath: relPath, lifecycleState: "analyzing", analysisStep: "vad" })
			.where(eq(replays.id, replayId))
			.run();

		const { processor, transcription } = makeProcessor();
		const result = await processor({ replayId });
		expect(result.ok).toBe(true);
		expect(result.turnsWritten).toBe(2);

		// The agent turn's slice must reach past the quiet reply's end (6.0s).
		// Its window starts at the user turn's voiced end (~1.0s), so covering
		// the reply needs at least the 1.5s→6.0s span.
		const longest = transcription.calls.reduce((a, b) => (b.sampleCount > a.sampleCount ? b : a));
		expect(longest.sampleCount).toBeGreaterThanOrEqual((SAMPLE_RATE * (6000 - 1500)) / 1000);

		// And the slice actually contains the quiet reply: a sustained run of
		// sub-threshold-amplitude samples. A 2s sine at amplitude 2_500 puts
		// ~59% of its 96_000 samples in [1_500, 3_500]; the loud 300ms blip
		// only sweeps through that band briefly (~1_300 samples). A 40_000
		// floor cleanly separates "covered the reply" from "only saw the blip".
		let quietBandSamples = 0;
		for (const v of longest.audio) {
			const mag = Math.abs(v);
			if (mag >= 1_500 && mag <= 3_500) quietBandSamples++;
		}
		expect(quietBandSamples).toBeGreaterThanOrEqual(40_000);
	});

	it("stamps failed + failure_reason='transcription_failed' when the provider errors", async () => {
		const { replayId } = await seedReplayForAudio(store);
		const wav = makeStereo({
			userBlocks: [{ durationMs: 300, voiced: true }],
			agentBlocks: [{ durationMs: 300, voiced: true }],
		});
		const wavBytes = writeStereoWav(wav);
		const relPath = `${replayId}/replay.wav`;
		const absPath = join(audio.path, relPath);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, wavBytes);
		store.db
			.update(replays)
			.set({ audioPath: relPath, lifecycleState: "analyzing", analysisStep: "vad" })
			.where(eq(replays.id, replayId))
			.run();

		const runner = makeFakeJobRunner();
		const transcription = makeFakeTranscriptionProvider({
			error: new Error("provider down"),
		});
		const processor = makeAnalyzeProcessor(
			store,
			audio.path,
			makeReplayEvents(),
			runner,
			transcription,
		);
		await expect(processor({ replayId })).rejects.toThrow(/transcription stage failed/);

		const after = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(after?.lifecycleState).toBe("failed");
		expect(after?.failureReason).toBe("transcription_failed");
		expect(runner.enqueued).toEqual([]);
	});

	it("skips the chain when the row is no longer in 'analyzing' (race guard)", async () => {
		const { replayId } = await seedReplayForAudio(store);
		const wav = makeStereo({
			userBlocks: [{ durationMs: 100, voiced: true }],
			agentBlocks: [{ durationMs: 100, voiced: true }],
		});
		const wavBytes = writeStereoWav(wav);
		const relPath = `${replayId}/replay.wav`;
		const absPath = join(audio.path, relPath);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, wavBytes);
		store.db
			.update(replays)
			.set({
				audioPath: relPath,
				lifecycleState: "failed",
				failureReason: "max_attempts_exceeded",
			})
			.where(eq(replays.id, replayId))
			.run();

		const { processor, runner } = makeProcessor();
		const result = await processor({ replayId });
		expect(result.ok).toBe(true);

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("failed");
		expect(row?.failureReason).toBe("max_attempts_exceeded");
		expect(runner.enqueued).toEqual([]);
	});

	it("throws when audio_path is null", async () => {
		const { replayId } = await seedReplayForAudio(store);
		const { processor } = makeProcessor();
		await expect(processor({ replayId })).rejects.toThrow(/audio_path is null/);
	});

	it("throws when the replay doesn't exist", async () => {
		const { processor } = makeProcessor();
		await expect(processor({ replayId: "00000000-0000-0000-0000-000000000099" })).rejects.toThrow(
			/replay row not found/,
		);
	});
});
