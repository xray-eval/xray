import {
	conversations,
	modelUsage,
	replayEvaluations,
	replayMetrics,
	replays,
	replayTurns,
} from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import type { ReplayLifecycleState } from "@/server/store/types.ts";

import { ensureRunConfig } from "./run-configs.groups.ts";

export interface SeedGroupedReplayInput {
	readonly id: string;
	readonly conversationHash: string;
	readonly conversationName?: string;
	readonly config: unknown;
	readonly configName?: string;
	readonly startedAt: string;
	readonly lifecycleState?: ReplayLifecycleState;
	/** One entry per agent turn. User turns are added around them implicitly. */
	readonly agentTurns?: readonly {
		readonly agentResponseMs: number | null;
		readonly interrupted?: boolean;
		readonly yieldMs?: number | null;
	}[];
	readonly modelCalls?: readonly {
		readonly ttftMs?: number | null;
		readonly latencyMs?: number | null;
		readonly inputTokens?: number | null;
		readonly outputTokens?: number | null;
		/**
		 * Independent of the split, matching the column: Langfuse reads all three
		 * from separate attributes and can report a total with no breakdown.
		 */
		readonly totalTokens?: number | null;
	}[];
	readonly passed?: boolean;
	/** Per-replay assertion tally. Defaults to one, matching `passed`. */
	readonly assertions?: { readonly passed: number; readonly total: number };
	/** Per-replay judge tally. Defaults to none declared. */
	readonly judges?: { readonly passed: number; readonly total: number };
}

/**
 * Seed one grouped replay with the derived rows the aggregates read, creating
 * its conversation and run-config group on first use.
 *
 * Turns alternate user/agent starting with a user turn, so an agent turn always
 * has a preceding user turn — the shape `calculate-metrics` produces, and the
 * shape the role join in `fetchGroupRows` expects. Returns the group hash.
 */
export function seedGroupedReplay(store: Store, input: SeedGroupedReplayInput): string {
	const existingConversation = store.db.select().from(conversations).all();
	if (!existingConversation.some((c) => c.hash === input.conversationHash)) {
		store.db
			.insert(conversations)
			.values({
				hash: input.conversationHash,
				name: input.conversationName ?? `conversation ${input.conversationHash.slice(0, 4)}`,
				turnsJson: JSON.stringify({ turns: [], judges: [] }),
				createdAt: input.startedAt,
				lastRunAt: input.startedAt,
			})
			.run();
	}

	const group = ensureRunConfig(store.db, {
		config: input.config,
		...(input.configName !== undefined ? { name: input.configName } : {}),
		now: input.startedAt,
	});

	const lifecycleState = input.lifecycleState ?? "completed";
	store.db
		.insert(replays)
		.values({
			id: input.id,
			conversationHash: input.conversationHash,
			lifecycleState,
			analysisStep: null,
			failureReason: lifecycleState === "failed" ? "transcription_failed" : null,
			startedAt: input.startedAt,
			finishedAt: null,
			recordingStartedAt: null,
			audioPath: null,
			runConfigJson: JSON.stringify(input.config),
			runConfigHash: group.hash,
			jobId: null,
		})
		.run();

	let turnIdx = 0;
	for (const agentTurn of input.agentTurns ?? []) {
		insertTurn(store, input.id, turnIdx, "user");
		store.db
			.insert(replayMetrics)
			.values({
				replayId: input.id,
				turnIdx,
				agentResponseMs: null,
				interrupted: false,
				interruptionStartMs: null,
				yieldMs: null,
			})
			.run();
		turnIdx += 1;

		insertTurn(store, input.id, turnIdx, "agent");
		const interrupted = agentTurn.interrupted ?? false;
		store.db
			.insert(replayMetrics)
			.values({
				replayId: input.id,
				turnIdx,
				agentResponseMs: agentTurn.agentResponseMs,
				interrupted,
				interruptionStartMs: interrupted ? 100 : null,
				yieldMs: agentTurn.yieldMs ?? null,
			})
			.run();
		turnIdx += 1;
	}

	for (const call of input.modelCalls ?? []) {
		store.db
			.insert(modelUsage)
			.values({
				replayId: input.id,
				spanId: null,
				provider: "openai",
				model: "gpt-4o",
				inputTokens: call.inputTokens ?? null,
				outputTokens: call.outputTokens ?? null,
				totalTokens: call.totalTokens ?? null,
				ttftMs: call.ttftMs ?? null,
				startedAt: input.startedAt,
				endedAt: input.startedAt,
				latencyMs: call.latencyMs ?? null,
			})
			.run();
	}

	if (input.passed !== undefined) {
		store.db
			.insert(replayEvaluations)
			.values({
				replayId: input.id,
				passed: input.passed,
				assertionsTotal: input.assertions?.total ?? 1,
				assertionsPassed: input.assertions?.passed ?? (input.passed ? 1 : 0),
				judgesTotal: input.judges?.total ?? 0,
				judgesPassed: input.judges?.passed ?? 0,
				evaluatedAt: input.startedAt,
			})
			.run();
	}

	return group.hash;
}

function insertTurn(store: Store, replayId: string, idx: number, role: "user" | "agent"): void {
	const start = idx * 1000;
	store.db
		.insert(replayTurns)
		.values({
			replayId,
			idx,
			role,
			turnStartMs: start,
			turnEndMs: start + 900,
			voiceStartMs: start,
			voiceEndMs: start + 900,
		})
		.run();
}
