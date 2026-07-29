import { eq } from "drizzle-orm";

import { conversations, replays, runConfigs } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import {
	fakeHash,
	makeConversationInput,
	makeReplayInput,
	makeTempStore,
} from "@/server/store/test-utils.ts";

import { RunConfigNotFoundError } from "./run-configs.errors.ts";
import { hashRunConfig } from "./run-configs.hash.ts";
import {
	backfillRunConfigs,
	compareRunConfigs,
	ensureRunConfig,
	getRunConfigDetail,
	listRunConfigs,
} from "./run-configs.service.ts";
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

describe("ensureRunConfig", () => {
	test("inserts the group on first write and returns its row", () => {
		const row = ensureRunConfig(store.db, {
			config: { model: "gpt-4o" },
			name: "baseline",
			now: NOW,
		});
		expect(row.hash).toBe(hashRunConfig({ model: "gpt-4o" }));
		expect(row.name).toBe("baseline");
		expect(row.configJson).toBe('{"model":"gpt-4o"}');
		expect(row.createdAt).toBe(NOW);
	});

	test("a config with permuted keys lands in the same group", () => {
		const first = ensureRunConfig(store.db, {
			config: { model: "gpt-4o", temperature: 0.5 },
			now: NOW,
		});
		const second = ensureRunConfig(store.db, {
			config: { temperature: 0.5, model: "gpt-4o" },
			now: "2026-07-30T10:00:00.000Z",
		});
		expect(second.hash).toBe(first.hash);
		expect(store.db.select().from(runConfigs).all()).toHaveLength(1);
	});

	test("re-writing with a new name renames the group — last write wins", () => {
		ensureRunConfig(store.db, { config: { model: "gpt-4o" }, name: "baseline", now: NOW });
		const renamed = ensureRunConfig(store.db, {
			config: { model: "gpt-4o" },
			name: "control-group",
			now: "2026-07-30T10:00:00.000Z",
		});
		expect(renamed.name).toBe("control-group");
	});

	test("an unnamed re-write keeps the existing name instead of erasing it", () => {
		ensureRunConfig(store.db, { config: { model: "gpt-4o" }, name: "baseline", now: NOW });
		const unnamed = ensureRunConfig(store.db, { config: { model: "gpt-4o" }, now: NOW });
		expect(unnamed.name).toBe("baseline");
	});

	test("created_at survives an upsert — the group is as old as its first run", () => {
		ensureRunConfig(store.db, { config: { model: "gpt-4o" }, now: NOW });
		const again = ensureRunConfig(store.db, {
			config: { model: "gpt-4o" },
			now: "2026-08-01T10:00:00.000Z",
		});
		expect(again.createdAt).toBe(NOW);
	});
});

describe("backfillRunConfigs", () => {
	function insertLegacyReplay(id: string, runConfigJson: string | null) {
		store.db
			.insert(replays)
			.values(
				makeReplayInput({ id, conversationHash: CONVERSATION, runConfigJson, runConfigHash: null }),
			)
			.run();
	}

	test("groups replays that predate run-config identity", () => {
		insertLegacyReplay("legacy-a", '{"model":"gpt-4o"}');
		insertLegacyReplay("legacy-b", '{"model":"gpt-4o"}');
		insertLegacyReplay("legacy-c", '{"model":"gemini-2.5-flash"}');

		const grouped = backfillRunConfigs(store, { now: () => NOW });

		expect(grouped).toBe(3);
		expect(store.db.select().from(runConfigs).all()).toHaveLength(2);
		const a = store.db.select().from(replays).where(eq(replays.id, "legacy-a")).get();
		const b = store.db.select().from(replays).where(eq(replays.id, "legacy-b")).get();
		expect(a?.runConfigHash).toBe(hashRunConfig({ model: "gpt-4o" }));
		expect(b?.runConfigHash).toBe(a?.runConfigHash);
	});

	test("leaves legacy groups unnamed — no label exists to recover", () => {
		insertLegacyReplay("legacy-a", '{"model":"gpt-4o"}');
		backfillRunConfigs(store, { now: () => NOW });
		expect(store.db.select().from(runConfigs).all()[0]?.name).toBeNull();
	});

	test("skips replays with no run config at all", () => {
		insertLegacyReplay("no-config", null);
		expect(backfillRunConfigs(store, { now: () => NOW })).toBe(0);
		expect(store.db.select().from(runConfigs).all()).toHaveLength(0);
	});

	test("skips a corrupt run_config_json instead of failing the whole startup", () => {
		insertLegacyReplay("corrupt", "{not json");
		insertLegacyReplay("fine", '{"model":"gpt-4o"}');

		expect(backfillRunConfigs(store, { now: () => NOW })).toBe(1);
		const corrupt = store.db.select().from(replays).where(eq(replays.id, "corrupt")).get();
		expect(corrupt?.runConfigHash).toBeNull();
	});

	test("is idempotent — a second run has nothing left to do", () => {
		insertLegacyReplay("legacy-a", '{"model":"gpt-4o"}');
		backfillRunConfigs(store, { now: () => NOW });
		expect(backfillRunConfigs(store, { now: () => NOW })).toBe(0);
		expect(store.db.select().from(runConfigs).all()).toHaveLength(1);
	});
});

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

	test("per-conversation metrics are scoped to that conversation", () => {
		const { baseline } = seedTwoConfigs();
		const detail = getRunConfigDetail(store, baseline, "latest");
		expect(detail.conversations[0]?.metrics.agent_response_ms.avg).toBe(500);
		expect(detail.conversations[1]?.metrics.agent_response_ms.avg).toBe(800);
	});

	test("throws for an unknown group", () => {
		expect(() => getRunConfigDetail(store, "f".repeat(64), "latest")).toThrow(
			RunConfigNotFoundError,
		);
	});
});
