import { Hono } from "hono";

import { healthz } from "./healthz/healthz.ts";
import { createIngestRouter } from "./ingest/ingest.router.ts";
import type { Store } from "./store/store.ts";

export function createApp(store: Store): Hono {
	const app = new Hono();
	app.route("/healthz", healthz);
	app.route("/v1", createIngestRouter(store));
	return app;
}
