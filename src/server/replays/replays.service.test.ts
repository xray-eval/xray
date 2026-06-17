import { eq } from "drizzle-orm";

import { ConversationNotFoundError } from "@/server/conversations/conversations.errors.ts";
import { seedConversation } from "@/server/conversations/conversations.test-utils.ts";
import { makeFakeJobRunner } from "@/server/jobs/jobs.test-utils.ts";
import {
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
	turnTranscripts,
} from "@/server/store/schema.ts";
import { makeTempStore } from "@/server/store/test-utils.ts";

import {
	ReplayLifecycleTransitionError,
	ReplayNotFoundError,
	ReplayNotReadyForAnalysisError,
} from "./replays.errors.ts";
import type { ReplayEvent } from "./replays.events.ts";
import { makeReplayEvents } from "./replays.events.ts";
import {
	compareReplays,
	createReplay,
	enqueueAnalysis,
	getReplay,
	getReplayResult,
	listReplaysForConversation,
	markReplayFailed,
	updateReplay,
} from "./replays.service.ts";
import { seedReplay } from "./replays.test-utils.ts";
import { describe, expect, it } from "bun:test";

describe("createReplay", () => {
	it("creates a row with lifecycle_state='pending'", async () => {
		const store = makeTempStore();
		const { hash } = await seedConversation(store);
		const detail = createReplay(
			store,
			{ conversation_hash: hash },
			{ now: () => "2026-05-18T12:00:00.000Z" },
		);
		expect(detail.lifecycle_state).toBe("pending");
		expect(detail.started_at).toBe("2026-05-18T12:00:00.000Z");
		expect(detail.id).toMatch(/[0-9a-f-]{36}/);
		expect(detail.analysis_step).toBeNull();
		expect(detail.failure_reason).toBeNull();
		store.close();
	});

	it("rejects unknown conversation_hash", () => {
		const store = makeTempStore();
		expect(() => createReplay(store, { conversation_hash: "f".repeat(64) })).toThrow(
			ConversationNotFoundError,
		);
		store.close();
	});

	it("persists run_config as JSON for later diff", async () => {
		const store = makeTempStore();
		const { hash } = await seedConversation(store);
		const detail = createReplay(store, {
			conversation_hash: hash,
			run_config: { model: "gpt-4o", temperature: 0.5 },
		});
		expect(detail.run_config).toEqual({ model: "gpt-4o", temperature: 0.5 });
		store.close();
	});
});

describe("updateReplay", () => {
	it("applies lifecycle_state + finished_at", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		const after = updateReplay(store, replayId, {
			lifecycle_state: "running",
			finished_at: null,
		});
		expect(after.lifecycle_state).toBe("running");
		store.close();
	});

	it("throws ReplayNotFoundError for unknown id", () => {
		const store = makeTempStore();
		expect(() =>
			updateReplay(store, "00000000-0000-0000-0000-000000000000", {
				lifecycle_state: "running",
			}),
		).toThrow(ReplayNotFoundError);
		store.close();
	});

	it("ignores an empty patch", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		const before = getReplay(store, replayId);
		const after = updateReplay(store, replayId, {});
		expect(after).toEqual(before);
		store.close();
	});

	it("rejects transitions out of a terminal state", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		updateReplay(store, replayId, { lifecycle_state: "failed", failure_reason: "driver_aborted" });
		expect(() => updateReplay(store, replayId, { lifecycle_state: "completed" })).toThrow(
			ReplayLifecycleTransitionError,
		);
		expect(() => updateReplay(store, replayId, { lifecycle_state: "failed" })).not.toThrow();
		store.close();
	});

	it("rejects an API PATCH that mutates `analyzing` (worker owns the lifecycle)", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "analyzing", analysisStep: "vad", jobId: "j-1" })
			.where(eq(replays.id, replayId))
			.run();
		expect(() => updateReplay(store, replayId, { lifecycle_state: "failed" })).toThrow(
			ReplayLifecycleTransitionError,
		);
		expect(() => updateReplay(store, replayId, { lifecycle_state: "completed" })).toThrow(
			ReplayLifecycleTransitionError,
		);
		expect(() => updateReplay(store, replayId, { lifecycle_state: "analyzing" })).not.toThrow();
		expect(() =>
			updateReplay(store, replayId, { failure_reason: "max_attempts_exceeded" }),
		).not.toThrow();
		store.close();
	});
});

describe("markReplayFailed", () => {
	it("writes lifecycle_state='failed' + reason + finished_at and emits SSE events", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "analyzing", analysisStep: "vad", jobId: "job-1" })
			.where(eq(replays.id, replayId))
			.run();
		const events = makeReplayEvents();
		const seen: ReplayEvent[] = [];
		events.subscribe(replayId, (e) => seen.push(e));

		markReplayFailed(store, events, replayId, "max_attempts_exceeded", {
			now: () => "2026-05-21T12:34:56.000Z",
		});

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("failed");
		expect(row?.failureReason).toBe("max_attempts_exceeded");
		expect(row?.analysisStep).toBeNull();
		expect(row?.finishedAt).toBe("2026-05-21T12:34:56.000Z");
		expect(seen).toEqual([
			{ type: "failed", reason: "max_attempts_exceeded" },
			{ type: "state", lifecycle_state: "failed", analysis_step: null },
		]);
		store.close();
	});

	it("is idempotent: second call on a row already in `failed` is a no-op", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		const events = makeReplayEvents();
		markReplayFailed(store, events, replayId, "max_attempts_exceeded", {
			now: () => "2026-05-21T12:00:00.000Z",
		});
		const afterFirst = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		const seen: ReplayEvent[] = [];
		events.subscribe(replayId, (e) => seen.push(e));

		markReplayFailed(store, events, replayId, "stalled", {
			now: () => "2026-05-21T13:00:00.000Z",
		});

		const afterSecond = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(afterSecond?.finishedAt).toBe(afterFirst?.finishedAt);
		expect(afterSecond?.failureReason).toBe("max_attempts_exceeded");
		expect(seen).toEqual([]);
		store.close();
	});

	it("refuses to unwind a row already in `completed`", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		updateReplay(store, replayId, {
			lifecycle_state: "completed",
			finished_at: "2026-05-21T10:00:00.000Z",
		});
		const events = makeReplayEvents();
		const seen: ReplayEvent[] = [];
		events.subscribe(replayId, (e) => seen.push(e));

		markReplayFailed(store, events, replayId, "max_attempts_exceeded");

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("completed");
		expect(row?.failureReason).toBeNull();
		expect(seen).toEqual([]);
		store.close();
	});

	it("silently returns when the replay id does not exist", () => {
		const store = makeTempStore();
		const events = makeReplayEvents();
		expect(() =>
			markReplayFailed(store, events, "00000000-0000-0000-0000-0000000000ff", "worker_lost"),
		).not.toThrow();
		store.close();
	});
});

describe("enqueueAnalysis — atomic claim", () => {
	async function seedRecordingUploaded(store: ReturnType<typeof makeTempStore>): Promise<string> {
		const { replayId } = await seedReplay(store);
		store.db
			.update(replays)
			.set({ lifecycleState: "recording_uploaded", audioPath: `${replayId}/replay.wav` })
			.where(eq(replays.id, replayId))
			.run();
		return replayId;
	}

	it("two concurrent calls: exactly one enqueues, the other throws ReplayNotReadyForAnalysisError", async () => {
		const store = makeTempStore();
		const replayId = await seedRecordingUploaded(store);
		const events = makeReplayEvents();

		const gate = Promise.withResolvers<void>();
		let enqueuedCount = 0;
		const runner = makeFakeJobRunner();
		const gatedRunner = {
			...runner,
			async enqueue(
				name: "analyze-replay" | "calculate-metrics" | "evaluate-replay",
				payload: { replayId: string },
			) {
				enqueuedCount += 1;
				await gate.promise;
				return runner.enqueue(name, payload);
			},
		};

		const a = enqueueAnalysis(store, gatedRunner, events, replayId);
		const b = enqueueAnalysis(store, gatedRunner, events, replayId);
		await Promise.resolve();
		await Promise.resolve();
		gate.resolve();

		const settled = await Promise.allSettled([a, b]);
		const fulfilled = settled.filter((s) => s.status === "fulfilled");
		const rejected = settled.filter((s) => s.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const rejection = rejected[0];
		if (rejection?.status !== "rejected") throw new Error("expected one rejection");
		expect(rejection.reason).toBeInstanceOf(ReplayNotReadyForAnalysisError);
		expect(enqueuedCount).toBe(1);

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("analyzing");
		expect(row?.analysisStep).toBe("vad");
		store.close();
	});

	it("rolls back to `recording_uploaded` when the bunqueue enqueue throws", async () => {
		const store = makeTempStore();
		const replayId = await seedRecordingUploaded(store);
		const events = makeReplayEvents();
		const throwingRunner = {
			async enqueue() {
				throw new Error("bunqueue offline");
			},
			async close() {
				// no-op
			},
		};

		await expect(enqueueAnalysis(store, throwingRunner, events, replayId)).rejects.toThrow(
			"bunqueue offline",
		);

		const row = store.db.select().from(replays).where(eq(replays.id, replayId)).get();
		expect(row?.lifecycleState).toBe("recording_uploaded");
		expect(row?.analysisStep).toBeNull();
		expect(row?.jobId).toBeNull();
		store.close();
	});
});

describe("getReplay / compareReplays / listReplaysForConversation", () => {
	it("getReplay throws ReplayNotFoundError for missing id", () => {
		const store = makeTempStore();
		expect(() => getReplay(store, "00000000-0000-0000-0000-000000000000")).toThrow(
			ReplayNotFoundError,
		);
		store.close();
	});

	it("compareReplays preserves request order", async () => {
		const store = makeTempStore();
		const { replayId: a } = await seedReplay(store, {
			id: "00000000-0000-0000-0000-00000000000a",
		});
		const { replayId: b } = await seedReplay(store, {
			id: "00000000-0000-0000-0000-00000000000b",
		});
		const { replayId: c } = await seedReplay(store, {
			id: "00000000-0000-0000-0000-00000000000c",
		});
		const res = compareReplays(store, [c, a, b]);
		expect(res.replays.map((r) => r.id)).toEqual([c, a, b]);
		store.close();
	});

	it("listReplaysForConversation returns newest-first summaries", async () => {
		const store = makeTempStore();
		const { hash } = await seedConversation(store);
		await seedReplay(store, { conversationHash: hash });
		const { replayId } = await seedReplay(store, { conversationHash: hash });
		updateReplay(store, replayId, {
			lifecycle_state: "completed",
			finished_at: "2026-05-18T12:10:00.000Z",
		});
		const items = listReplaysForConversation(store, hash);
		expect(items).toHaveLength(2);
		const first = items[0]?.started_at ?? "";
		const second = items[1]?.started_at ?? "";
		expect(first >= second).toBe(true);
		store.close();
	});
});

describe("buildReplayDetail — transcripts projection", () => {
	it("parses words_json into snake_case word timings, ordered by turn_idx", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.insert(turnTranscripts)
			.values([
				{
					replayId,
					turnIdx: 1,
					text: "hello there",
					language: "en",
					wordsJson: JSON.stringify([
						{ text: "hello", startMs: 100, endMs: 400 },
						{ text: "there", startMs: 410, endMs: 700 },
					]),
					durationMs: 600,
					provider: "openai_whisper",
					model: "whisper-1",
				},
				{
					replayId,
					turnIdx: 0,
					text: "hi",
					language: "en",
					wordsJson: null,
					durationMs: 300,
					provider: "openai_whisper",
					model: "whisper-1",
				},
			])
			.run();

		const detail = getReplay(store, replayId);

		expect(detail.transcripts.map((t) => t.turn_idx)).toEqual([0, 1]);
		expect(detail.transcripts[0]?.words).toBeNull();
		expect(detail.transcripts[1]?.words).toEqual([
			{ text: "hello", start_ms: 100, end_ms: 400 },
			{ text: "there", start_ms: 410, end_ms: 700 },
		]);
		store.close();
	});

	it("degrades a malformed words_json to null instead of throwing", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.insert(turnTranscripts)
			.values({
				replayId,
				turnIdx: 0,
				text: "hi",
				language: null,
				wordsJson: "{not valid json",
				durationMs: 300,
				provider: "openai_whisper",
				model: "whisper-1",
			})
			.run();

		const detail = getReplay(store, replayId);

		expect(detail.transcripts[0]?.words).toBeNull();
		expect(detail.transcripts[0]?.text).toBe("hi");
		store.close();
	});

	it("collapses an empty words array to null so the client never maps over zero words", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.insert(turnTranscripts)
			.values({
				replayId,
				turnIdx: 0,
				text: "hi",
				language: null,
				wordsJson: "[]",
				durationMs: 300,
				provider: "openai_whisper",
				model: "whisper-1",
			})
			.run();

		const detail = getReplay(store, replayId);

		expect(detail.transcripts[0]?.words).toBeNull();
		expect(detail.transcripts[0]?.text).toBe("hi");
		store.close();
	});

	it("degrades valid-JSON-but-wrong-shape words to null instead of throwing", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.insert(turnTranscripts)
			.values({
				replayId,
				turnIdx: 0,
				text: "hi",
				language: null,
				// Parses as JSON, but the elements miss startMs/endMs — the schema
				// rejects it, so the v.safeParse failure branch must degrade to null.
				wordsJson: JSON.stringify([{ text: "hi" }]),
				durationMs: 300,
				provider: "openai_whisper",
				model: "whisper-1",
			})
			.run();

		const detail = getReplay(store, replayId);

		expect(detail.transcripts[0]?.words).toBeNull();
		expect(detail.transcripts[0]?.text).toBe("hi");
		store.close();
	});
});

describe("getReplayResult — interruption timing", () => {
	it("projects interruption_start_ms onto the per-turn metrics", async () => {
		const store = makeTempStore();
		const { replayId } = await seedReplay(store);
		store.db
			.insert(replayTurns)
			.values([
				{
					replayId,
					idx: 0,
					role: "agent",
					turnStartMs: 0,
					turnEndMs: 2000,
					voiceStartMs: 100,
					voiceEndMs: 1900,
				},
			])
			.run();
		store.db
			.insert(replayMetrics)
			.values({
				replayId,
				turnIdx: 0,
				agentResponseMs: 250,
				interrupted: true,
				interruptionStartMs: 1450,
			})
			.run();
		store.db
			.insert(replayEvaluations)
			.values({
				replayId,
				passed: true,
				assertionsTotal: 0,
				assertionsPassed: 0,
				judgesTotal: 0,
				judgesPassed: 0,
				evaluatedAt: "2026-05-18T12:00:00.000Z",
			})
			.run();

		const result = getReplayResult(store, replayId);

		expect(result?.metrics.turns[0]?.interrupted).toBe(true);
		expect(result?.metrics.turns[0]?.interruption_start_ms).toBe(1450);
		store.close();
	});
});
