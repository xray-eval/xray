import { readFileSync } from "node:fs";

import { Database } from "bun:sqlite";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export interface Store {
	readonly db: Database;
	close(): void;
}

export interface OpenStoreOptions {
	/**
	 * Filesystem path to the SQLite database, or `:memory:` for an ephemeral
	 * test database. Caller is responsible for ensuring the parent directory
	 * exists when using a file path.
	 */
	path: string;
}

/**
 * Open (or create) the xray SQLite store, apply schema, and return a typed
 * handle. Re-running against an existing DB is a no-op — the schema is
 * `IF NOT EXISTS` throughout and `PRAGMA user_version` stays at 1.
 */
export function openStore(opts: OpenStoreOptions): Store {
	const db = new Database(opts.path, { create: true, strict: true });
	// WAL: readers and the single writer don't block each other. Safe choice
	// since one Bun process owns the DB (see `.claude/rules/single-image-distribution.md`).
	db.exec("PRAGMA journal_mode = WAL");
	// FK enforcement is off by default in SQLite. Required for ON DELETE CASCADE.
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(SCHEMA_SQL);
	return { db, close: () => db.close() };
}
