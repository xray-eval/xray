import { Hono } from "hono";

import { loadEnv } from "./env/env.ts";
import { healthz } from "./healthz/healthz.ts";

export const app = new Hono();

app.route("/healthz", healthz);

/* v8 ignore start -- bootstrap, exercised by Bun at runtime not vitest */
if (import.meta.main) {
	const env = loadEnv();
	const server = Bun.serve({ port: env.PORT, hostname: env.HOST, fetch: app.fetch });
	console.info(`xray listening on ${server.hostname}:${server.port}`);
}
/* v8 ignore stop */
