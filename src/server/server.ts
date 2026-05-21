import { Hono } from "hono";

import { createAudioRouter } from "./audio/audio.router.ts";
import { createConversationsRouter } from "./conversations/conversations.router.ts";
import { createDocsRouter } from "./docs/docs.router.ts";
import { healthz } from "./healthz/healthz.ts";
import type { JobRunner } from "./jobs/jobs.bunqueue.ts";
import { createOtlpRouter } from "./otlp/otlp.router.ts";
import type { ReplayEvents } from "./replays/replays.events.ts";
import { createReplaysRouter } from "./replays/replays.router.ts";
import type { Store } from "./store/store.ts";

export interface AppConfig {
	/** Absolute path. Full-replay audio files live under this root. */
	readonly audioRoot: string;
	readonly jobRunner: JobRunner;
	readonly events: ReplayEvents;
}

export function createApp(store: Store, config: AppConfig): Hono {
	const app = new Hono();
	app.route("/healthz", healthz);
	app.route("/v1", createConversationsRouter(store));
	app.route("/v1", createReplaysRouter(store, config.jobRunner, config.events));
	app.route("/v1", createOtlpRouter(store));
	app.route("/v1", createAudioRouter(store, config.audioRoot));
	app.route("/", createDocsRouter(app));
	return app;
}
