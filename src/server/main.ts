import { mkdirSync } from "node:fs";
import { join } from "node:path";

// `import index from "*.html"` triggers Bun's HTML bundler: Bun walks the
// shell's `<script type="module">` tags and bundles the React entry on boot.
// With `bun --hot` the bundle is rebuilt + HMR'd on file change.
import index from "../../index.html";
import { loadEnv } from "./env/env.ts";
import { createApp } from "./server.ts";
import { openStoreFromEnv } from "./store/store.ts";

const env = loadEnv();
// Open the store at boot so migrations run before the first request and any
// misconfiguration fails-fast instead of surfacing on a route handler.
const store = openStoreFromEnv(env);

const audioRoot = env.XRAY_AUDIO_ROOT ?? join(env.XRAY_DATA_DIR, "audio");
mkdirSync(audioRoot, { recursive: true });

const app = createApp(store, { audioRoot });

const server = Bun.serve({
	port: env.PORT,
	hostname: env.HOST,
	development: process.env.NODE_ENV !== "production",
	routes: {
		// Specific API routes go through Hono. Add new endpoints both here
		// (Bun.serve route) and inside `app` (Hono route) — Bun.serve picks
		// the most-specific match, so the SPA catchall below does not shadow
		// them.
		"/healthz": (req) => app.fetch(req),
		"/v1/*": (req) => app.fetch(req),
		"/openapi.json": (req) => app.fetch(req),
		"/docs": (req) => app.fetch(req),
		// SPA fallback for any other path. Client-side routing handled in
		// React.
		"/*": index,
	},
});

console.info(
	`xray listening on ${server.hostname}:${server.port} (db=${env.XRAY_DATA_DIR}/xray.db, audio=${audioRoot})`,
);
