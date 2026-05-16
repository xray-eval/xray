// `import index from "*.html"` triggers Bun's HTML bundler: Bun walks the
// shell's `<script type="module">` tags and bundles the React entry on boot.
// With `bun --hot` the bundle is rebuilt + HMR'd on file change.
import index from "../../index.html";
import { loadEnv } from "./env/env.ts";
import { app } from "./server.ts";
import { openStoreFromEnv } from "./store/store.ts";

const env = loadEnv();
// Open the store at boot so migrations run before the first request and any
// misconfiguration fails-fast instead of surfacing on a route handler.
openStoreFromEnv(env);

const server = Bun.serve({
	port: env.PORT,
	hostname: env.HOST,
	development: process.env.NODE_ENV !== "production",
	routes: {
		// Specific API routes route through Hono. Add new server endpoints both
		// here (Bun.serve route) and inside `app` (Hono route) — Bun.serve picks
		// the most-specific match, so the SPA catchall below does not shadow them.
		"/healthz": (req) => app.fetch(req),
		// SPA fallback: any other path returns the bundled HTML shell. Client-
		// side routing (`/sessions/:id`, etc.) is handled in React.
		"/*": index,
	},
});

console.info(
	`xray listening on ${server.hostname}:${server.port} (db=${env.XRAY_DATA_DIR}/xray.db)`,
);
