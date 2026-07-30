import { eq } from "drizzle-orm";

import { conversations, replays, runConfigs } from "@/server/store/schema.ts";
import type { Store } from "@/server/store/store.ts";
import {
	fakeHash,
	makeConversationInput,
	makeReplayInput,
	makeTempStore,
} from "@/server/store/test-utils.ts";

import { backfillRunConfigs, ensureRunConfig } from "./run-configs.groups.ts";
import { hashRunConfig } from "./run-configs.hash.ts";
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
