import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import * as schema from "./schema.ts";
import { Database } from "bun:sqlite";

const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;

export type StoreSchema = typeof schema;
export type StoreDb = BunSQLiteDatabase<StoreSchema>;

export interface Store {
	readonly db: StoreDb;
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
 * Open (or create) the xray SQLite store, run any pending migrations, and
 * return a Drizzle handle. Reopening an existing DB is a no-op — drizzle's
 * `__drizzle_migrations` table records which migrations have already run.
 */
export function openStore(opts: OpenStoreOptions): Store {
	const sqlite = new Database(opts.path, { create: true, strict: true });
	// WAL: readers and the single writer don't block each other. Safe choice
	// since one Bun process owns the DB (see `.claude/rules/single-image-distribution.md`).
	sqlite.exec("PRAGMA journal_mode = WAL");
	// FK enforcement is off by default in SQLite. Required for ON DELETE CASCADE.
	sqlite.exec("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	return { db, close: () => sqlite.close() };
}
