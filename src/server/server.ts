import { Hono } from "hono";

import { healthz } from "./healthz/healthz.ts";
import { createIngestRouter } from "./ingest/ingest.router.ts";
import { createReplaysRouter } from "./replays/replays.router.ts";
import { createSessionsRouter } from "./sessions/sessions.router.ts";
import type { Store } from "./store/store.ts";

export function createApp(store: Store): Hono {
	const app = new Hono();
	app.route("/healthz", healthz);
	app.route("/v1", createIngestRouter(store));
	app.route("/v1", createSessionsRouter(store));
	app.route("/v1", createReplaysRouter(store));
	return app;
}
