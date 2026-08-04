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
	 *  pass a sub-threshold value (< ~707 ⇒ mean energy < 2.5e5) to lay
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

	it("extends a turn's slice past its voiced end to catch a quiet trailing reply", async () => {
		// Regression from a real deployment: the agent's actual reply sat
		// inside the turn but after its last speech segment, so a slice pinned
		// to the VAD voiced extent carried only pre-reply audio,
		// `turn_transcripts.text` came back "", and the judge scored a perfect
		// answer as "offers no help at all".
		//
		// Model that here: the agent turn's detected voice is a short loud
		// blip at 1.5s, and the actual reply is a quiet 2s tone at 4.0–6.0s —
		// below the VAD energy threshold (amplitude 300 ⇒ mean energy
		// 4.5e4 < 2.5e5), so no speech segment marks it. The slice must still
		// cover it: the agent turn is the last turn on its channel, so its window
		// runs from its own voice onset to where its audio stops — which is past
		// the quiet reply, since a sub-VAD tone still carries signal.
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
				{ durationMs: 2000, voiced: true, amplitude: 300 },
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

		// The agent turn's slice — its window starts at the agent's own voice
		// onset (~1.5s) and, being the last turn on its channel, extends to where
		// its channel goes quiet — must contain the quiet reply. Detect it by a sustained
		// run of sub-threshold-amplitude samples: a 2s sine at amplitude 300 puts
		// 40_000 of its 96_000 samples in [150, 275], a band the 15_000-amplitude
		// blips never linger in (0 samples each), so a 30_000 floor cleanly picks
		// out the one slice that actually covered the reply.
		const coveredQuietReply = transcription.calls.some((call) => {
			let quietBandSamples = 0;
			for (const v of call.audio) {
				const mag = Math.abs(v);
				if (mag >= 150 && mag <= 275) quietBandSamples++;
			}
			return quietBandSamples >= 30_000;
		});
		expect(coveredQuietReply).toBe(true);
	});

	it("stops a turn's slice where the channel goes silent, not at the end of the file", async () => {
		// Regression from replay 2a8fd70b: the agent stopped speaking 12.5s into a
		// 60s recording (the driver waited out a turn that never came), and because
		// the last turn on each channel extended to the recording end, the provider
		// was handed 57-second slices that were 80% silence. It answered with an
		// empty transcript for one turn and a sentence the audio could not contain
		// for another, and the judge then graded that text.
		const { replayId } = await seedReplayForAudio(store);
		const wav = makeStereo({
			userBlocks: [
				{ durationMs: 1000, voiced: true },
				{ durationMs: 40_000, voiced: false },
			],
			agentBlocks: [
				{ durationMs: 1200, voiced: false },
				{ durationMs: 800, voiced: true },
				{ durationMs: 40_000, voiced: false },
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
		expect((await processor({ replayId })).ok).toBe(true);

		// Every slice must end near the last audible sample (~2.0s), not at 41s.
		const longestMs = Math.max(
			...transcription.calls.map((call) => (call.audio.length / SAMPLE_RATE) * 1000),
		);
		expect(longestMs).toBeLessThan(5_000);
	});

	it("transcribes an interrupting turn from its own onset, not the interrupted turn's tail", async () => {
		// Barge-in: the user speaks 0–1.5s, then cuts back in at 4.0s while the
		// agent (2.0–4.3s) is still finishing. Both channels are voiced across
		// 4.0–4.3s. The interrupting user turn must be transcribed from its own
		// 4.0s onset — the previous cross-channel window pushed its slice to the
		// agent's 4.3s tail, clipping the front of the barge-in.
		const { replayId } = await seedReplayForAudio(store);
		const wav = makeStereo({
			userBlocks: [
				{ durationMs: 1500, voiced: true },
				{ durationMs: 2500, voiced: false },
				{ durationMs: 1200, voiced: true },
			],
			agentBlocks: [
				{ durationMs: 2000, voiced: false },
				{ durationMs: 2300, voiced: true },
				{ durationMs: 1400, voiced: false },
				{ durationMs: 1800, voiced: true },
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

		const { processor } = makeProcessor();
		const result = await processor({ replayId });
		expect(result.ok).toBe(true);

		const turns = store.db
			.select()
			.from(replayTurns)
			.where(eq(replayTurns.replayId, replayId))
			.orderBy(replayTurns.idx)
			.all();
		expect(turns.map((t) => t.role)).toEqual(["user", "agent", "user", "agent"]);
		// The interrupting user turn's boundary is clamped back to its own onset
		// (~4.0s), not the agent's 4.3s tail.
		const interruptingTurn = turns[2];
		expect(interruptingTurn?.turnStartMs).toBe(interruptingTurn?.voiceStartMs);
		expect(interruptingTurn?.voiceStartMs).toBeLessThan(4300);

		// Its transcript covers the full interruption (4.0–5.2s), not the ~0.9s
		// left after clipping to the agent's tail.
		const transcript = store.db
			.select()
			.from(turnTranscripts)
			.where(eq(turnTranscripts.replayId, replayId))
			.all();
		expect(transcript).toHaveLength(4);
		const interruptingTranscript = transcript.find((t) => t.turnIdx === 2);
		expect(interruptingTranscript?.durationMs).toBeGreaterThanOrEqual(1200);
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
