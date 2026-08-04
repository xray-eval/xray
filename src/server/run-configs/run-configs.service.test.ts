import { conversations } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import { fakeHash, makeConversationInput, makeTempStore } from "@/server/store/test-utils.ts";

import { RunConfigNotFoundError } from "./run-configs.errors.ts";
import { ensureRunConfig } from "./run-configs.groups.ts";
import { compareRunConfigs, getRunConfigDetail, listRunConfigs } from "./run-configs.service.ts";
import { seedGroupedReplay } from "./run-configs.test-utils.ts";
import { beforeEach, describe, expect, test } from "bun:test";

let store: Store;
const CONVERSATION = fakeHash(11);

beforeEach(() => {
	store = makeTempStore();
	store.db
		.insert(conversations)
		.values(makeConversationInput({ hash: CONVERSATION }))
		.run();
});

const NOW = "2026-07-29T10:00:00.000Z";

const BASELINE = { model: "gpt-4o" };
const FAST = { model: "gemini-2.5-flash" };
const CONV_A = "a".repeat(64);
const CONV_B = "b".repeat(64);
const CONV_C = "c".repeat(64);

/**
 * Two configs over overlapping conversation sets: baseline ran A, B and C
 * (C failed); fast ran A and B only. That asymmetry is what the coverage
 * counts and the intersection scope exist to surface.
 */
function seedTwoConfigs(): { baseline: string; fast: string } {
	const baseline = seedGroupedReplay(store, {
		id: "base-a",
		conversationHash: CONV_A,
		conversationName: "alpha",
		config: BASELINE,
		configName: "baseline",
		startedAt: "2026-07-01T00:00:00.000Z",
		agentTurns: [
			{ agentResponseMs: 400 },
			{ agentResponseMs: 600, interrupted: true, yieldMs: 200 },
		],
		modelCalls: [{ ttftMs: 300, latencyMs: 900, inputTokens: 10, outputTokens: 5 }],
		passed: true,
	});
	seedGroupedReplay(store, {
		id: "base-b",
		conversationHash: CONV_B,
		conversationName: "bravo",
		config: BASELINE,
		startedAt: "2026-07-01T01:00:00.000Z",
		agentTurns: [{ agentResponseMs: 800 }],
		passed: false,
	});
	seedGroupedReplay(store, {
		id: "base-c-failed",
		conversationHash: CONV_C,
		conversationName: "charlie",
		config: BASELINE,
		startedAt: "2026-07-01T02:00:00.000Z",
		lifecycleState: "failed",
	});
	const fast = seedGroupedReplay(store, {
		id: "fast-a",
		conversationHash: CONV_A,
		config: FAST,
		configName: "fast-follow",
		startedAt: "2026-07-02T00:00:00.000Z",
		agentTurns: [{ agentResponseMs: 200 }],
		modelCalls: [{ ttftMs: 150, latencyMs: 500, inputTokens: 12, outputTokens: 6 }],
		passed: true,
	});
	seedGroupedReplay(store, {
		id: "fast-b",
		conversationHash: CONV_B,
		config: FAST,
		startedAt: "2026-07-02T01:00:00.000Z",
		agentTurns: [{ agentResponseMs: 300 }],
		passed: true,
	});
	return { baseline, fast };
}

describe("listRunConfigs", () => {
	test("reports coverage per group so the picker shows what each config spans", () => {
		seedTwoConfigs();
		const { items } = listRunConfigs(store);
		const baseline = items.find((i) => i.name === "baseline");
		expect(baseline?.coverage).toEqual({ conversations: 3, replays: 3, failed_replays: 1 });
		expect(baseline?.config).toEqual(BASELINE);
	});

	test("sorts most recently run first", () => {
		seedTwoConfigs();
		const { items } = listRunConfigs(store);
		expect(items.map((i) => i.name)).toEqual(["fast-follow", "baseline"]);
	});

	test("returns nothing when no replay ever carried a run config", () => {
		expect(listRunConfigs(store).items).toEqual([]);
	});

	test("still lists a group no replay points at, counted as zero", () => {
		ensureRunConfig(store.db, { config: BASELINE, name: "orphan", now: NOW });
		const { items } = listRunConfigs(store);
		expect(items).toHaveLength(1);
		expect(items[0]?.coverage).toEqual({ conversations: 0, replays: 0, failed_replays: 0 });
		expect(items[0]?.last_run_at).toBeNull();
	});
});

describe("compareRunConfigs", () => {
	test("aggregates each group over its own latest completed replays", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		const [base, fastGroup] = result.groups;
		expect(base?.metrics.agent_response_ms.avg).toBe(600);
		expect(base?.metrics.agent_response_ms.n).toBe(3);
		expect(fastGroup?.metrics.agent_response_ms.avg).toBe(250);
		expect(fastGroup?.metrics.agent_response_ms.n).toBe(2);
	});

	test("keeps the requested column order so the UI can trust the array", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [fast, baseline],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		expect(result.groups.map((g) => g.hash)).toEqual([fast, baseline]);
	});

	test("surfaces the coverage gap between the two configs", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		expect(result.union_conversations).toBe(2);
		expect(result.intersection_conversations).toBe(2);
		expect(result.groups[0]?.coverage.failed_replays).toBe(1);
	});

	test("intersection scope stops attributing an excluded conversation's failure", () => {
		// baseline's only failure is in CONV_C, which no other config completed, so
		// intersection excludes it. Counting it anyway renders "compared on 2 of 3
		// · 1 failed" — a failure badge on a shared workload that had none.
		const { baseline, fast } = seedTwoConfigs();
		const intersection = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "intersection",
		});
		expect(intersection.groups[0]?.coverage.failed_replays).toBe(0);
	});

	test("intersection still counts a failure inside the shared workload", () => {
		// The narrowing must not become a way to hide failures: a config that
		// failed a conversation every config ran is exactly the signal to keep.
		const { baseline, fast } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-a-failed",
			conversationHash: CONV_A,
			config: BASELINE,
			startedAt: "2026-07-04T00:00:00.000Z",
			lifecycleState: "failed",
		});
		const intersection = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "intersection",
		});
		expect(intersection.groups[0]?.coverage.failed_replays).toBe(1);
	});

	test("union keeps counting a failure that is the config's only run of that conversation", () => {
		// Under union the whole point is that a config which fails runs outright
		// stays visible, even though a conversation it never completed is absent
		// from every config's completed set.
		const { baseline, fast } = seedTwoConfigs();
		const union = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		expect(union.groups[0]?.coverage.failed_replays).toBe(1);
	});

	test("intersection scope drops a conversation only one config completed", () => {
		const { baseline, fast } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-d-only",
			conversationHash: "d".repeat(64),
			conversationName: "delta",
			config: BASELINE,
			startedAt: "2026-07-01T03:00:00.000Z",
			agentTurns: [{ agentResponseMs: 5000 }],
		});

		const union = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		const intersection = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "intersection",
		});

		expect(union.union_conversations).toBe(3);
		expect(union.intersection_conversations).toBe(2);
		expect(union.groups[0]?.coverage.conversations).toBe(3);
		expect(intersection.groups[0]?.coverage.conversations).toBe(2);
		// The 5000ms outlier lives in the unshared conversation, so it inflates
		// the union average and must not touch the intersection average.
		expect(union.groups[0]?.metrics.agent_response_ms.avg).toBe(1700);
		expect(intersection.groups[0]?.metrics.agent_response_ms.avg).toBe(600);
	});

	test("all selection pools every completed replay of a conversation", () => {
		const { baseline, fast } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-a-rerun",
			conversationHash: CONV_A,
			config: BASELINE,
			startedAt: "2026-07-03T00:00:00.000Z",
			agentTurns: [{ agentResponseMs: 1000 }],
		});

		const latest = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		const all = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "all",
			conversation_scope: "union",
		});
		expect(latest.groups[0]?.coverage.replays).toBe(2);
		expect(all.groups[0]?.coverage.replays).toBe(3);
	});

	test("a failed replay's turn metrics never reach the aggregates", () => {
		const { baseline, fast } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-b-failed-rerun",
			conversationHash: CONV_B,
			config: BASELINE,
			startedAt: "2026-07-05T00:00:00.000Z",
			lifecycleState: "failed",
			agentTurns: [{ agentResponseMs: 9999 }],
		});

		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		// The failed rerun is the newest run of bravo, but it contributes nothing:
		// 400/600 from alpha and 800 from bravo's last completed run.
		expect(result.groups[0]?.metrics.agent_response_ms.avg).toBe(600);
		expect(result.groups[0]?.metrics.agent_response_ms.n).toBe(3);
	});

	test("reads a total-only token count out of the store", () => {
		// The aggregate can only see `total_tokens` if the query selects it, and a
		// Langfuse-instrumented agent reports nothing else. Without this the whole
		// token row reads "—  n=0" for a config the inspector shows tokens for.
		const hash = seedGroupedReplay(store, {
			id: "total-only",
			conversationHash: CONVERSATION,
			config: BASELINE,
			startedAt: "2026-07-01T00:00:00.000Z",
			modelCalls: [{ inputTokens: null, outputTokens: null, totalTokens: 1500 }],
		});
		const detail = getRunConfigDetail(store, hash, "latest");
		expect(detail.metrics.tokens).toEqual({
			avg_input: null,
			avg_output: null,
			avg_total: 1500,
			n: 1,
		});
	});

	test("throws for an unknown group rather than silently dropping a column", () => {
		const { baseline } = seedTwoConfigs();
		expect(() =>
			compareRunConfigs(store, {
				config_hashes: [baseline, "f".repeat(64)],
				replay_selection: "latest",
				conversation_scope: "union",
			}),
		).toThrow(RunConfigNotFoundError);
	});

	test("names every conversation in scope once, so a grid has stable rows", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		// Sorted by name so row order doesn't depend on which config ran what.
		expect(result.conversations.map((c) => c.name)).toEqual(["alpha", "bravo"]);
		expect(result.conversations.map((c) => c.hash)).toEqual([CONV_A, CONV_B]);
	});

	test("breaks each group down per conversation, for a cell per row and column", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		const baselineCells = result.groups[0]?.conversations ?? [];
		const alpha = baselineCells.find((c) => c.conversation_hash === CONV_A);
		const bravo = baselineCells.find((c) => c.conversation_hash === CONV_B);
		// baseline's alpha replay had agent turns at 400ms and 600ms.
		expect(alpha?.metrics.agent_response_ms.avg).toBe(500);
		expect(alpha?.metrics.pass).toEqual({ passed: 1, total: 1 });
		// bravo's single replay failed its evaluation.
		expect(bravo?.metrics.pass).toEqual({ passed: 0, total: 1 });
	});

	test("omits a cell for a conversation the config never completed", () => {
		// The grid has to distinguish "ran it and scored zero" from "never ran
		// it" — a missing cell is not a zero.
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		const fastCells = result.groups[1]?.conversations ?? [];
		expect(fastCells.map((c) => c.conversation_hash).includes(CONV_C)).toBe(false);
	});

	test("narrows the conversation list to the shared set under the intersection scope", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "intersection",
		});
		// charlie is baseline-only and failed, so it is not shared workload.
		expect(result.conversations.map((c) => c.name)).toEqual(["alpha", "bravo"]);
		for (const group of result.groups) {
			expect(group.conversations).toHaveLength(2);
		}
	});

	test("carries a replay id per cell so a number can be listened to", () => {
		const { baseline, fast } = seedTwoConfigs();
		const result = compareRunConfigs(store, {
			config_hashes: [baseline, fast],
			replay_selection: "latest",
			conversation_scope: "union",
		});
		const alpha = result.groups[0]?.conversations.find((c) => c.conversation_hash === CONV_A);
		expect(alpha?.replay_id).toBe("base-a");
	});
});

describe("getRunConfigDetail", () => {
	test("lists the conversations the config ran, each linked to a real replay", () => {
		const { baseline } = seedTwoConfigs();
		const detail = getRunConfigDetail(store, baseline, "latest");
		expect(detail.conversations.map((c) => c.conversation_name)).toEqual(["alpha", "bravo"]);
		const alpha = detail.conversations[0];
		expect(alpha?.replay_id).toBe("base-a");
		expect(alpha?.replays).toEqual([
			{ id: "base-a", started_at: "2026-07-01T00:00:00.000Z", passed: true },
		]);
	});

	test("the linked replay is the newest completed one for that conversation", () => {
		const { baseline } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-a-rerun",
			conversationHash: CONV_A,
			config: BASELINE,
			startedAt: "2026-07-03T00:00:00.000Z",
			agentTurns: [{ agentResponseMs: 100 }],
			passed: true,
		});
		const detail = getRunConfigDetail(store, baseline, "latest");
		expect(detail.conversations[0]?.replay_id).toBe("base-a-rerun");
	});

	test("all selection keeps every replay reachable, newest first", () => {
		const { baseline } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-a-rerun",
			conversationHash: CONV_A,
			config: BASELINE,
			startedAt: "2026-07-03T00:00:00.000Z",
			agentTurns: [{ agentResponseMs: 100 }],
			passed: false,
		});
		const detail = getRunConfigDetail(store, baseline, "all");
		expect(detail.conversations[0]?.replays.map((r) => r.id)).toEqual(["base-a-rerun", "base-a"]);
		expect(detail.conversations[0]?.replay_id).toBe("base-a-rerun");
	});

	test("omits a conversation whose only replay failed — nothing to link to", () => {
		const { baseline } = seedTwoConfigs();
		const detail = getRunConfigDetail(store, baseline, "latest");
		expect(detail.conversations.map((c) => c.conversation_hash)).not.toContain(CONV_C);
		expect(detail.coverage.failed_replays).toBe(1);
	});

	test("latest selection leaves an earlier run's metrics out of the aggregate", () => {
		const { baseline } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-a-rerun",
			conversationHash: CONV_A,
			config: BASELINE,
			startedAt: "2026-07-03T00:00:00.000Z",
			agentTurns: [{ agentResponseMs: 100 }],
			passed: true,
		});
		const detail = getRunConfigDetail(store, baseline, "latest");
		// alpha's newest run measured 100ms; the 400/600ms first run must not
		// average into the row that links to the rerun.
		expect(detail.conversations[0]?.metrics.agent_response_ms).toMatchObject({ avg: 100, n: 1 });
	});

	test("per-conversation metrics are scoped to that conversation", () => {
		const { baseline } = seedTwoConfigs();
		const detail = getRunConfigDetail(store, baseline, "latest");
		expect(detail.conversations[0]?.metrics.agent_response_ms.avg).toBe(500);
		expect(detail.conversations[1]?.metrics.agent_response_ms.avg).toBe(800);
	});

	test("header coverage describes the whole group, matching the card that linked here", () => {
		// The picker card counts every replay in the group. Scoping the detail
		// header to the selection instead made the two disagree with identical
		// wording — and under `latest` made `replays` a restatement of
		// `conversations`, since that selection keeps exactly one of each.
		const { baseline } = seedTwoConfigs();
		seedGroupedReplay(store, {
			id: "base-a-rerun",
			conversationHash: CONV_A,
			config: BASELINE,
			startedAt: "2026-07-03T00:00:00.000Z",
			agentTurns: [{ agentResponseMs: 100 }],
			passed: true,
		});
		const detail = getRunConfigDetail(store, baseline, "latest");
		expect(detail.coverage).toEqual({ conversations: 3, replays: 4, failed_replays: 1 });
		expect(listRunConfigs(store).items.find((i) => i.hash === baseline)?.coverage).toEqual(
			detail.coverage,
		);
	});

	test("throws for an unknown group", () => {
		expect(() => getRunConfigDetail(store, "f".repeat(64), "latest")).toThrow(
			RunConfigNotFoundError,
		);
	});
});
