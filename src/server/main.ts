import { mkdirSync } from "node:fs";
import { join } from "node:path";

// `import index from "*.html"` triggers Bun's HTML bundler: Bun walks the
// shell's `<script type="module">` tags and bundles the React entry on boot.
// With `bun --hot` the bundle is rebuilt + HMR'd on file change.
import index from "../../index.html";
import { loadEnv } from "./env/env.ts";
import { createApp } from "./server.ts";
import { sweepOrphanedReplayRuns } from "./store/replay-runs-repo.ts";
import { openStoreFromEnv } from "./store/store.ts";

const env = loadEnv();
// Open the store at boot so migrations run before the first request and any
// misconfiguration fails-fast instead of surfacing on a route handler.
const store = openStoreFromEnv(env);

const audioRoot = join(env.XRAY_DATA_DIR, "audio");
mkdirSync(audioRoot, { recursive: true });

// Single-writer model: any replay row in `running` is from a process that
// died holding it. Mark them failed so the UI shows them broken instead of
// stuck "in progress" forever.
const orphaned = sweepOrphanedReplayRuns(store.db, new Date().toISOString());
if (orphaned > 0) {
	console.warn(`Marked ${orphaned} orphaned replay run(s) as failed`);
}

const app = createApp(store, { audioRoot });

const server = Bun.serve({
	port: env.PORT,
	hostname: env.HOST,
	development: process.env.NODE_ENV !== "production",
	routes: {
		// Specific API routes route through Hono. Add new server endpoints both
		// here (Bun.serve route) and inside `app` (Hono route) — Bun.serve picks
		// the most-specific match, so the SPA catchall below does not shadow them.
		"/healthz": (req) => app.fetch(req),
		"/v1/*": (req) => app.fetch(req),
		"/openapi.json": (req) => app.fetch(req),
		"/asyncapi.json": (req) => app.fetch(req),
		"/docs": (req) => app.fetch(req),
		// SPA fallback: any other path returns the bundled HTML shell. Client-
		// side routing (`/sessions/:id`, etc.) is handled in React.
		"/*": index,
	},
});

console.info(
	`xray listening on ${server.hostname}:${server.port} (db=${env.XRAY_DATA_DIR}/xray.db)`,
);
