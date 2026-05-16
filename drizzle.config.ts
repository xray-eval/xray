import { defineConfig } from "drizzle-kit";

// drizzle-kit reads this for `generate` (schema → SQL migration files) and
// `studio` commands. Runtime code does NOT read this — `store.ts` constructs
// the Drizzle handle directly. The `dbCredentials.url` here is only used by
// `drizzle-kit studio`; production paths come from `XRAY_DATA_DIR` via env.ts.
//
// See `.claude/rules/single-image-distribution.md` §4: only the SQLite
// dialect is permitted here. A PR that switches `dialect` to anything else
// is a smoke signal.
export default defineConfig({
	dialect: "sqlite",
	schema: "./src/server/store/schema.ts",
	out: "./src/server/store/migrations",
	dbCredentials: {
		url: "./data/xray.db",
	},
});
