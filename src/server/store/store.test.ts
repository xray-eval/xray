import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";

import { makeEnv } from "@/server/env/test-utils.ts";

import { StoreParentDirNotFoundError } from "./errors.ts";
import { sessions, toolCalls, turns } from "./schema.ts";
import { saveSession } from "./sessions-repo.ts";
import { openStore, openStoreFromEnv } from "./store.ts";
import { makeSession } from "./test-utils.ts";
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
		expect(tables).toEqual(expect.arrayContaining(["sessions", "turns", "tool_calls"]));
		store.close();
	});

	it("enables WAL journal mode", () => {
		// :memory: databases report `memory`, not `wal` — exercise on a file path.
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
		saveSession(first.db, makeSession({ id: "persist-me" }));
		first.close();

		// Reopen — drizzle's __drizzle_migrations table records that 0000_initial
		// already ran, so `migrate()` is a no-op and data stays.
		const second = openStore({ path });
		const row = second.db.select().from(sessions).where(eq(sessions.id, "persist-me")).get();
		expect(row?.id).toBe("persist-me");
		second.close();
	});

	it("throws StoreParentDirNotFoundError when the parent dir is missing", () => {
		const missing = join(tmpDir, "does-not-exist", "xray.db");
		expect(() => openStore({ path: missing })).toThrow(StoreParentDirNotFoundError);
	});

	it("cascades session deletes to turns and tool_calls", () => {
		const store = openStore({ path: ":memory:" });
		saveSession(store.db, makeSession({ id: "cascade-me" }));
		store.db
			.insert(turns)
			.values({
				id: "turn-1",
				sessionId: "cascade-me",
				idx: 0,
				role: "user",
				text: "hi",
				ts: "2026-05-16T12:00:00.000Z",
			})
			.run();
		store.db
			.insert(toolCalls)
			.values({ turnId: "turn-1", idx: 0, name: "lookup", argsJson: "{}" })
			.run();

		store.db.delete(sessions).where(eq(sessions.id, "cascade-me")).run();

		expect(store.db.select().from(turns).all()).toEqual([]);
		expect(store.db.select().from(toolCalls).all()).toEqual([]);
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
		saveSession(first.db, makeSession({ id: "persist-me" }));
		first.close();

		const second = openStoreFromEnv(env);
		const row = second.db.select().from(sessions).where(eq(sessions.id, "persist-me")).get();
		expect(row?.id).toBe("persist-me");
		second.close();
	});
});
