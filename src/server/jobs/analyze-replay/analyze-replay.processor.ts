import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { deriveTurns } from "@/server/audio/audio.turns.ts";
import { runVadOnChannel } from "@/server/audio/audio.vad.ts";
import { downsamplePcm, readStereoWav } from "@/server/audio/audio.wav.ts";
import type { ReplayEvents } from "@/server/replays/replays.events.ts";
import { findReplay } from "@/server/replays/replays.service.ts";
import { replays, replayTurns, speechSegments } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";

import type { AnalyzeProcessor } from "../jobs.bunqueue.ts";
import { JobProcessingError } from "../jobs.errors.ts";

const VAD_SAMPLE_RATE = 16_000;

/**
 * Build the analyze-replay processor closure. Reads the replay's stereo WAV
 * from disk, downsamples each channel to 16kHz, runs the energy VAD, derives
 * turn boundaries, and writes the resulting rows in one transaction:
 *   - replace `speech_segments` for this replay
 *   - replace `replay_turns` for this replay
 *   - flip `replays.lifecycle_state` to `completed`
 *
 * Errors throw `JobProcessingError`; bunqueue's retry policy handles transient
 * IO. After max attempts the wrapper's `onFailed` hook flips the replay to
 * `failed` with a reason mapped from the bunqueue DLQ.
 */
export function makeAnalyzeProcessor(
	store: Store,
	audioRoot: string,
	events: ReplayEvents,
): AnalyzeProcessor {
	return async ({ replayId }) => {
		const replay = findReplay(store, replayId);
		if (replay === undefined) {
			throw new JobProcessingError(replayId, "replay row not found");
		}
		if (replay.audioPath === null) {
			throw new JobProcessingError(replayId, "audio_path is null — upload missing");
		}

		const wavPath = join(audioRoot, replay.audioPath);
		let wavBytes: Uint8Array;
		try {
			wavBytes = await readFile(wavPath);
		} catch (cause) {
			throw new JobProcessingError(replayId, `failed to read WAV at ${wavPath}`, { cause });
		}

		const wav = readStereoWav(wavBytes);
		events.emit(replayId, { type: "progress", percent: 10, step: "vad" });

		const userPcm = downsamplePcm(wav.left, wav.sampleRate, VAD_SAMPLE_RATE);
		const agentPcm = downsamplePcm(wav.right, wav.sampleRate, VAD_SAMPLE_RATE);

		const userSegments = runVadOnChannel(userPcm, VAD_SAMPLE_RATE);
		const agentSegments = runVadOnChannel(agentPcm, VAD_SAMPLE_RATE);
		events.emit(replayId, { type: "progress", percent: 60, step: "turns" });

		const turns = deriveTurns(userSegments, agentSegments);

		store.db.transaction((tx) => {
			tx.delete(speechSegments).where(eq(speechSegments.replayId, replayId)).run();
			tx.delete(replayTurns).where(eq(replayTurns.replayId, replayId)).run();

			const segRows = [
				...userSegments.map((s) => ({
					replayId,
					channel: "user" as const,
					startMs: s.startMs,
					endMs: s.endMs,
				})),
				...agentSegments.map((s) => ({
					replayId,
					channel: "agent" as const,
					startMs: s.startMs,
					endMs: s.endMs,
				})),
			];
			if (segRows.length > 0) {
				tx.insert(speechSegments).values(segRows).run();
			}

			if (turns.length > 0) {
				tx.insert(replayTurns)
					.values(
						turns.map((t) => ({
							replayId,
							idx: t.idx,
							role: t.role,
							turnStartMs: t.turnStartMs,
							turnEndMs: t.turnEndMs,
							voiceStartMs: t.voiceStartMs,
							voiceEndMs: t.voiceEndMs,
						})),
					)
					.run();
			}

			tx.update(replays)
				.set({
					lifecycleState: "completed",
					analysisStep: null,
					finishedAt: new Date().toISOString(),
				})
				.where(eq(replays.id, replayId))
				.run();
		});

		events.emit(replayId, { type: "state", lifecycle_state: "completed", analysis_step: null });
		events.emit(replayId, {
			type: "completed",
			turns_written: turns.length,
			segments_written: userSegments.length + agentSegments.length,
		});

		return {
			ok: true,
			turnsWritten: turns.length,
			segmentsWritten: userSegments.length + agentSegments.length,
		};
	};
}
