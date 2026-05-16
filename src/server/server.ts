import { Hono } from "hono";

import { healthz } from "./healthz/healthz.ts";

export const app = new Hono();

app.route("/healthz", healthz);

/* v8 ignore start -- bootstrap, exercised by Bun at runtime not vitest */
if (import.meta.main) {
	const port = Number(process.env["PORT"] ?? 8080);
	const hostname = process.env["HOST"] ?? "0.0.0.0";
	const server = Bun.serve({ port, hostname, fetch: app.fetch });
	console.info(`xray listening on ${server.hostname}:${server.port}`);
}
/* v8 ignore stop */
