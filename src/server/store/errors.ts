export class StoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		// Set explicitly per class — `new.target.name` would be mangled by minifiers.
		this.name = "StoreError";
	}
}

export class StoreParentDirNotFoundError extends StoreError {
	readonly path: string;
	readonly parent: string;

	constructor(path: string, parent: string) {
		super(`Cannot open SQLite store at "${path}" — parent directory "${parent}" does not exist`);
		this.name = "StoreParentDirNotFoundError";
		this.path = path;
		this.parent = parent;
	}
}

/**
 * A legacy pre-rewrite xray schema (sessions / replay_runs / tool_calls_v1 /
 * turns) was detected at the opened DB path and the new schema's tables are
 * absent. Drizzle's migrator would otherwise raise a raw `SQLITE_ERROR` on
 * the first `CREATE TABLE` collision; we surface it as a typed startup
 * failure with an actionable message so the operator knows the alpha break
 * happened and what to do.
 */
export class LegacySchemaDetectedError extends StoreError {
	readonly path: string;
	readonly legacyTables: readonly string[];

	constructor(path: string, legacyTables: readonly string[]) {
		super(
			`Detected legacy xray schema at ${path} (tables: ${legacyTables.join(", ")}). This is an alpha break — back up and wipe /data/xray.db, then restart.`,
		);
		this.name = "LegacySchemaDetectedError";
		this.path = path;
		this.legacyTables = legacyTables;
	}
}
