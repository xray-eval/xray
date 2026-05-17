import { Hono } from "hono";

import { createAudioRouter } from "./audio/audio.router.ts";
import { createDocsRouter } from "./docs/docs.router.ts";
import { healthz } from "./healthz/healthz.ts";
import { createIngestRouter } from "./ingest/ingest.router.ts";
import { createRealtimeReplaysRouter } from "./replays/realtime/realtime.router.ts";
import { createReplaysRouter } from "./replays/replays.router.ts";
import { createSessionsRouter } from "./sessions/sessions.router.ts";
import type { Store } from "./store/store.ts";

export interface AppConfig {
	/** Absolute path. Laid out as `<audioRoot>/<sessionId>/<turnIdx>.<ext>`. */
	readonly audioRoot: string;
}

export function createApp(store: Store, config: AppConfig): Hono {
	const app = new Hono();
	app.route("/healthz", healthz);
	app.route("/v1", createIngestRouter(store));
	app.route("/v1", createSessionsRouter(store));
	app.route("/v1", createReplaysRouter(store));
	app.route("/v1", createRealtimeReplaysRouter(store, config.audioRoot));
	app.route("/v1", createAudioRouter(store, config.audioRoot));
	// `createDocsRouter` captures `app` by reference and `generateSpecs(app)`
	// walks `app.routes` at request time, so mount order doesn't change the
	// resulting spec — but keep this at the bottom so the docs surface lives
	// next to the comment that explains how it gets built.
	app.route("/", createDocsRouter(app));
	return app;
}
