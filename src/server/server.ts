import { Hono } from "hono";

import { createAudioRouter } from "./audio/audio.router.ts";
import { healthz } from "./healthz/healthz.ts";
import { createIngestRouter } from "./ingest/ingest.router.ts";
import { createReplaysRouter } from "./replays/replays.router.ts";
import { createSessionsRouter } from "./sessions/sessions.router.ts";
import type { Store } from "./store/store.ts";

export interface AppConfig {
	/**
	 * Absolute path of the root directory that holds per-turn audio uploads,
	 * laid out as `<audioRoot>/<sessionId>/<turnIdx>.<ext>`. The production
	 * bootstrap derives this from `XRAY_DATA_DIR` so it shares the mounted
	 * volume with `xray.db` (per `.claude/rules/single-image-distribution.md`).
	 */
	readonly audioRoot: string;
}

export function createApp(store: Store, config: AppConfig): Hono {
	const app = new Hono();
	app.route("/healthz", healthz);
	app.route("/v1", createIngestRouter(store));
	app.route("/v1", createSessionsRouter(store));
	app.route("/v1", createReplaysRouter(store));
	app.route("/v1", createAudioRouter(store, config.audioRoot));
	return app;
}
