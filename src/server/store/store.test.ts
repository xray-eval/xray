import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";

import { makeEnv } from "@/server/env/test-utils.ts";

import { LegacySchemaDetectedError, StoreParentDirNotFoundError } from "./errors.ts";
import {
	conversations,
	modelUsage,
	replays,
	replayTurns,
	spans,
	speechSegments,
	toolCalls,
} from "./schema.ts";
import { openStore, openStoreFromEnv } from "./store.ts";
import {
	makeConversationInput,
	makeReplayInput,
	makeReplayTurnInput,
	makeSpanInput,
	makeSpeechSegmentInput,
} from "./test-utils.ts";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

interface PragmaRow {
	journal_mode?: string;
	user_version?: number;
	foreign_keys?: number;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "xray-store-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const tmpDbPath = () => join(tmpDir, "xray.db");

describe("openStore", () => {
	it("creates the expected tables on an empty DB", () => {
		const store = openStore({ path: ":memory:" });
		const tables = store.db
			.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
			.map((r) => r.name);
		expect(tables).toEqual(
			expect.arrayContaining([
				"conversations",
				"model_usage",
				"replay_turns",
				"replays",
				"spans",
				"speech_segments",
				"tool_calls",
			]),
		);
		expect(tables).not.toContain("replay_meta");
		expect(tables).not.toContain("assertions");
		store.close();
	});

	it("enables WAL journal mode", () => {
		const fileStore = openStore({ path: tmpDbPath() });
		const [row] = fileStore.db.all<PragmaRow>(sql`PRAGMA journal_mode`);
		expect(row?.journal_mode).toBe("wal");
		fileStore.close();
	});

	it("enables foreign-key enforcement", () => {
		const store = openStore({ path: ":memory:" });
		const [row] = store.db.all<PragmaRow>(sql`PRAGMA foreign_keys`);
		expect(row?.foreign_keys).toBe(1);
		store.close();
	});

	it("is idempotent: reopening the same file preserves data", () => {
		const path = tmpDbPath();
		const first = openStore({ path });
		first.db
			.insert(conversations)
			.values(makeConversationInput({ id: "persist-me" }))
			.run();
		first.close();

		const second = openStore({ path });
		const row = second.db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "persist-me"))
			.get();
		expect(row?.id).toBe("persist-me");
		second.close();
	});

	it("throws StoreParentDirNotFoundError when the parent dir is missing", () => {
		const missing = join(tmpDir, "does-not-exist", "xray.db");
		expect(() => openStore({ path: missing })).toThrow(StoreParentDirNotFoundError);
	});

	it("throws LegacySchemaDetectedError when a pre-rewrite schema is detected", () => {
		const path = tmpDbPath();
		const seed = new Database(path, { create: true, strict: true });
		seed.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
		seed.close();
		expect(() => openStore({ path })).toThrow(LegacySchemaDetectedError);
	});

	it("treats pre-audio-ground-truth tables as legacy (replay_meta)", () => {
		const path = tmpDbPath();
		const seed = new Database(path, { create: true, strict: true });
		seed.exec("CREATE TABLE replay_meta (replay_id TEXT PRIMARY KEY)");
		seed.close();
		expect(() => openStore({ path })).toThrow(LegacySchemaDetectedError);
	});

	it("does not flag a fresh DB or a DB already on the new schema", () => {
		const path = tmpDbPath();
		const fresh = openStore({ path });
		fresh.close();
		const reopen = openStore({ path });
		reopen.close();
	});

	it("cascades replay deletes to all replay-scoped tables", () => {
		const store = openStore({ path: ":memory:" });
		store.db
			.insert(conversations)
			.values(makeConversationInput({ id: "conv-cascade" }))
			.run();
		const replay = makeReplayInput({ id: "replay-cascade", conversationId: "conv-cascade" });
		store.db.insert(replays).values(replay).run();
		store.db
			.insert(replayTurns)
			.values(makeReplayTurnInput({ replayId: replay.id, idx: 0 }))
			.run();
		store.db
			.insert(speechSegments)
			.values(makeSpeechSegmentInput({ replayId: replay.id }))
			.run();
		store.db
			.insert(spans)
			.values(makeSpanInput({ replayId: replay.id }))
			.run();
		store.db
			.insert(toolCalls)
			.values({ replayId: replay.id, name: "lookup", argsJson: "{}" })
			.run();
		store.db
			.insert(modelUsage)
			.values({ replayId: replay.id, provider: "openai", model: "gpt-4o" })
			.run();

		store.db.delete(replays).where(eq(replays.id, replay.id)).run();

		expect(store.db.select().from(replayTurns).all()).toEqual([]);
		expect(store.db.select().from(speechSegments).all()).toEqual([]);
		expect(store.db.select().from(spans).all()).toEqual([]);
		expect(store.db.select().from(toolCalls).all()).toEqual([]);
		expect(store.db.select().from(modelUsage).all()).toEqual([]);
		store.close();
	});
});

describe("openStoreFromEnv", () => {
	it("creates XRAY_DATA_DIR if missing and opens xray.db inside it", () => {
		const dataDir = join(tmpDir, "fresh-data-dir");
		expect(existsSync(dataDir)).toBe(false);
		const store = openStoreFromEnv(makeEnv({ XRAY_DATA_DIR: dataDir }));
		expect(existsSync(join(dataDir, "xray.db"))).toBe(true);
		store.close();
	});

	it("is idempotent when the dir and db file already exist", () => {
		const env = makeEnv({ XRAY_DATA_DIR: join(tmpDir, "existing-data-dir") });
		const first = openStoreFromEnv(env);
		first.db
			.insert(conversations)
			.values(makeConversationInput({ id: "persist-me" }))
			.run();
		first.close();

		const second = openStoreFromEnv(env);
		const row = second.db
			.select()
			.from(conversations)
			.where(eq(conversations.id, "persist-me"))
			.get();
		expect(row?.id).toBe("persist-me");
		second.close();
	});
});
