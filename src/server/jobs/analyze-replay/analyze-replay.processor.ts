import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { sliceTurnAudio } from "@/server/audio/audio.slice.ts";
import { deriveTurns } from "@/server/audio/audio.turns.ts";
import type { StereoWav } from "@/server/audio/audio.types.ts";
import { runVadOnChannel } from "@/server/audio/audio.vad.ts";
import { readStereoWav, resamplePcm } from "@/server/audio/audio.wav.ts";
import type { ReplayEvents } from "@/server/replays/replays.events.ts";
import { findReplay, markReplayFailed } from "@/server/replays/replays.service.ts";
import { replays, replayTurns, speechSegments, turnTranscripts } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { MissingProviderCredentialError } from "@/server/transcription/transcription.errors.ts";
import type { TranscriptionProvider } from "@/server/transcription/transcription.types.ts";

import type { JobRunner } from "../jobs.bunqueue.ts";
import { JobProcessingError } from "../jobs.errors.ts";
import type { JobPayload } from "../jobs.types.ts";

export interface AnalyzeReplayResult {
	readonly ok: true;
	readonly turnsWritten: number;
	readonly segmentsWritten: number;
	readonly transcribedTurns: number;
}

export type AnalyzeReplayProcessor = (payload: JobPayload) => Promise<AnalyzeReplayResult>;

const VAD_SAMPLE_RATE = 16_000;

/**
 * First stage of the analyze chain. Reads the stereo WAV, runs VAD per
 * channel, derives turn boundaries, then runs per-turn transcription —
 * all in two commits inside the same processor invocation so a partial
 * transcription failure leaves the VAD output intact for debugging.
 *
 * Tool/model spans carry no stored turn idx — they're attributed to turns
 * at read/eval time by mapping their wall-clock `started_at` onto the audio
 * timeline (see `src/server/replays/timeline.ts`), so this stage no longer
 * touches `tool_calls` / `model_usage`.
 *
 * On success: enqueues `calculate-metrics` for the same replay id and
 * leaves the row in `analyzing` (analysis_step transitions vad →
 * transcribe → metrics). The final transition to `completed` lands in
 * the evaluate-replay processor.
 */
export function makeAnalyzeProcessor(
	store: Store,
	audioRoot: string,
	events: ReplayEvents,
	runner: JobRunner,
	transcription: TranscriptionProvider,
): AnalyzeReplayProcessor {
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

		const userPcm = resamplePcm(wav.left, wav.sampleRate, VAD_SAMPLE_RATE);
		const agentPcm = resamplePcm(wav.right, wav.sampleRate, VAD_SAMPLE_RATE);

		const userSegments = runVadOnChannel(userPcm, VAD_SAMPLE_RATE);
		const agentSegments = runVadOnChannel(agentPcm, VAD_SAMPLE_RATE);
		events.emit(replayId, { type: "progress", percent: 40, step: "vad" });

		const turns = deriveTurns(userSegments, agentSegments);

		// Worker holds the `analyzing` claim from enqueueAnalysis. If anything
		// (operator PATCH, future second-failure path) stamps `failed` before
		// we commit, we MUST NOT trash the existing rows that the prior
		// successful run left behind. Read the lifecycle inside the
		// transaction first; only delete+insert when the claim is still ours.
		const committed = store.db.transaction((tx) => {
			const current = tx.select().from(replays).where(eq(replays.id, replayId)).get();
			if (current?.lifecycleState !== "analyzing") return false;

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

			tx.update(replays).set({ analysisStep: "transcribe" }).where(eq(replays.id, replayId)).run();

			return true;
		});

		if (!committed) {
			console.warn(
				`analyze-replay worker for ${replayId} found the row no longer in 'analyzing' — skipping transcription stage`,
			);
			return {
				ok: true,
				turnsWritten: turns.length,
				segmentsWritten: userSegments.length + agentSegments.length,
				transcribedTurns: 0,
			};
		}

		events.emit(replayId, {
			type: "state",
			lifecycle_state: "analyzing",
			analysis_step: "transcribe",
		});
		events.emit(replayId, { type: "progress", percent: 50, step: "transcribe" });

		let transcribedCount = 0;
		try {
			transcribedCount = await runTranscriptionStage(store, replayId, wav, turns, transcription);
		} catch (cause) {
			// MissingProviderCredentialError signals an operator config gap
			// (the configured provider's API key is unset), NOT a transient
			// provider failure. Stamp a distinct reason so the operator's
			// first instinct is to set the env var, not to retry the run.
			const reason =
				cause instanceof MissingProviderCredentialError
					? "missing_credential"
					: "transcription_failed";
			markReplayFailed(store, events, replayId, reason);
			const detail = cause instanceof Error ? cause.message : String(cause);
			// Surface the underlying provider error to stderr so operators
			// can debug a transcription failure without digging into the
			// bunqueue tables — `JobProcessingError` thrown below carries
			// `cause` but bunqueue overwrites the failure result if a
			// subsequent retry early-exits successfully.
			console.error(
				`analyze-replay ${replayId} transcription stage failed (reason=${reason})`,
				cause,
			);
			throw new JobProcessingError(replayId, `transcription stage failed: ${detail}`, { cause });
		}

		events.emit(replayId, { type: "progress", percent: 90, step: "transcribe" });

		await runner.enqueue("calculate-metrics", { replayId });

		return {
			ok: true,
			turnsWritten: turns.length,
			segmentsWritten: userSegments.length + agentSegments.length,
			transcribedTurns: transcribedCount,
		};
	};
}

/**
 * Slice each turn's audio out of the stereo recording, hand it to the
 * transcription provider in parallel, and write `turn_transcripts` rows
 * inside one transaction. Any provider error aborts the whole stage —
 * partial transcription would leave the evaluator working on a
 * misleading subset.
 *
 * Each slice reads a single channel (left for user, right for agent) over
 * a per-channel window: it starts at the turn's own voice onset and runs
 * until the next turn ON THE SAME CHANNEL starts speaking (or the end of
 * the recording for the last turn on that channel). Two properties fall
 * out of that, and both matter:
 *
 *   - Overlap (a barge-in): starting at the turn's own `voiceStartMs`
 *     means an interrupting turn is transcribed from its first word, not
 *     from wherever the opposite channel happened to fall silent. Because
 *     the slice is single-channel, the overlapping opposite-channel turn
 *     doesn't fight it for samples.
 *   - Quiet trailing reply: extending to the NEXT same-channel onset (not
 *     stopping at `voiceEndMs`) keeps covering a reply that sits below the
 *     VAD energy threshold and so left no speech segment — the real
 *     deployment bug the regression test below pins down.
 *
 * The cross-channel tiling window (`clampedTurnWindows`) is deliberately
 * NOT used here: it pushed an interrupting turn's slice to start at the
 * previous (opposite-channel) turn's end, clipping the front of the
 * barge-in. That geometry still governs span attribution in the
 * evaluator, where windows must tile and not overlap — a different job.
 */
async function runTranscriptionStage(
	store: Store,
	replayId: string,
	wav: StereoWav,
	turns: ReadonlyArray<{
		idx: number;
		role: "user" | "agent";
		voiceStartMs: number;
		voiceEndMs: number;
	}>,
	transcription: TranscriptionProvider,
): Promise<number> {
	const recordingEndMs = Math.round((wav.left.length / wav.sampleRate) * 1000);
	// Shared AbortController so one Whisper rejection cancels the other
	// in-flight siblings. `Promise.all` rejects on first failure but does
	// NOT cancel the rest — they keep running and burning provider quota
	// for nothing. The provider merges this signal with its own timeout.
	const controller = new AbortController();
	let rows: Array<{
		replayId: string;
		turnIdx: number;
		text: string;
		language: string | null;
		wordsJson: string | null;
		durationMs: number;
		provider: string;
		model: string;
	}>;
	try {
		const settled = await Promise.all(
			turns.map(async (turn, i) => {
				const startMs = turn.voiceStartMs;
				// Extend to the next same-channel turn's onset (the recording end
				// for the last one), but never before this turn's own voiced end.
				const nextSameChannel = turns.slice(i + 1).find((t) => t.role === turn.role);
				const endMs = Math.max(
					turn.voiceEndMs,
					nextSameChannel !== undefined ? nextSameChannel.voiceStartMs : recordingEndMs,
				);
				if (endMs <= startMs) return null;
				const pcm = sliceTurnAudio(wav, turn.role, startMs, endMs);
				if (pcm.length === 0) return null;
				const result = await transcription.transcribe({
					audio: pcm,
					sampleRate: wav.sampleRate,
					signal: controller.signal,
				});
				return {
					replayId,
					turnIdx: turn.idx,
					text: result.text,
					language: result.language,
					wordsJson: result.words === null ? null : JSON.stringify(result.words),
					durationMs: result.durationMs,
					provider: transcription.name,
					model: transcription.model,
				};
			}),
		);
		rows = settled.filter((r) => r !== null);
	} catch (cause) {
		controller.abort();
		throw cause;
	}
	if (rows.length === 0) return 0;

	store.db.transaction((tx) => {
		tx.delete(turnTranscripts).where(eq(turnTranscripts.replayId, replayId)).run();
		tx.insert(turnTranscripts).values(rows).run();
	});

	return rows.length;
}
