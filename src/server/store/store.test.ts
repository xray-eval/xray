import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveSession } from "./sessions-repo.ts";
import { openStore } from "./store.ts";
import { makeSession } from "./test-utils.ts";

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
			.prepare<{ name: string }, []>(
				`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
			)
			.all()
			.map((r) => r.name);
		expect(tables).toEqual(expect.arrayContaining(["sessions", "turns", "tool_calls"]));
		store.close();
	});

	it("enables WAL journal mode", () => {
		const store = openStore({ path: ":memory:" });
		// :memory: databases report `memory`, not `wal` — exercise on a file path.
		store.close();

		const fileStore = openStore({ path: tmpDbPath() });
		const row = fileStore.db.prepare<PragmaRow, []>("PRAGMA journal_mode").get();
		expect(row?.journal_mode).toBe("wal");
		fileStore.close();
	});

	it("enables foreign-key enforcement", () => {
		const store = openStore({ path: ":memory:" });
		const row = store.db.prepare<PragmaRow, []>("PRAGMA foreign_keys").get();
		expect(row?.foreign_keys).toBe(1);
		store.close();
	});

	it("sets user_version to 1", () => {
		const store = openStore({ path: ":memory:" });
		const row = store.db.prepare<PragmaRow, []>("PRAGMA user_version").get();
		expect(row?.user_version).toBe(1);
		store.close();
	});

	it("is idempotent: reopening the same file preserves data and version", () => {
		const path = tmpDbPath();
		const first = openStore({ path });
		saveSession(first.db, makeSession({ id: "persist-me" }));
		first.close();

		// Reopen — schema reapplies as a no-op, data stays.
		const second = openStore({ path });
		const row = second.db
			.prepare<{ id: string }, [string]>("SELECT id FROM sessions WHERE id = ?")
			.get("persist-me");
		expect(row?.id).toBe("persist-me");
		const version = second.db.prepare<PragmaRow, []>("PRAGMA user_version").get();
		expect(version?.user_version).toBe(1);
		second.close();
	});

	it("cascades session deletes to turns and tool_calls", () => {
		const store = openStore({ path: ":memory:" });
		const sess = makeSession({ id: "cascade-me" });
		saveSession(store.db, sess);
		store.db
			.prepare(`INSERT INTO turns (id, session_id, idx, role, text, ts) VALUES (?, ?, ?, ?, ?, ?)`)
			.run("turn-1", "cascade-me", 0, "user", "hi", "2026-05-16T12:00:00.000Z");
		store.db
			.prepare(`INSERT INTO tool_calls (turn_id, idx, name, args_json) VALUES (?, ?, ?, ?)`)
			.run("turn-1", 0, "lookup", "{}");

		store.db.prepare(`DELETE FROM sessions WHERE id = ?`).run("cascade-me");

		const turnCount = store.db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM turns`).get();
		const toolCount = store.db
			.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tool_calls`)
			.get();
		expect(turnCount?.n).toBe(0);
		expect(toolCount?.n).toBe(0);
		store.close();
	});
});
