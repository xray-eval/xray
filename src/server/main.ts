import { mkdirSync } from "node:fs";
import { join } from "node:path";

// `import index from "*.html"` triggers Bun's HTML bundler: Bun walks the
// shell's `<script type="module">` tags and bundles the React entry on boot.
// With `bun --hot` the bundle is rebuilt + HMR'd on file change.
import index from "../../index.html";
import { loadEnv } from "./env/env.ts";
import { makeAnalyzeProcessor } from "./jobs/analyze-replay/analyze-replay.processor.ts";
import { createJobRunner } from "./jobs/jobs.bunqueue.ts";
import { makeReplayEvents } from "./replays/replays.events.ts";
import { markReplayFailed } from "./replays/replays.service.ts";
import { createApp } from "./server.ts";
import { openStoreFromEnv } from "./store/store.ts";

const env = loadEnv();
const store = openStoreFromEnv(env);

const audioRoot = env.XRAY_AUDIO_ROOT ?? join(env.XRAY_DATA_DIR, "audio");
mkdirSync(audioRoot, { recursive: true });

const events = makeReplayEvents();

// bunqueue opens its own SQLite file alongside `xray.db` (see
// `.claude/rules/single-image-distribution.md`'s "one volume, two files"
// acknowledgement). Path is configurable via BUNQUEUE_DATA_PATH so an
// operator can move it; default lives in the same data volume.
const bunqueuePath = env.BUNQUEUE_DATA_PATH ?? join(env.XRAY_DATA_DIR, "bunqueue.db");
const jobRunner = createJobRunner({
	dataPath: bunqueuePath,
	processor: makeAnalyzeProcessor(store, audioRoot, events),
	onFailed: (replayId, error) => {
		// bunqueue only fires `failed` once retries are exhausted (see
		// jobs.bunqueue.ts retry config). Map to `max_attempts_exceeded`
		// — the one ReplayFailureReason value that's faithful without
		// substring-matching the error message.
		console.error(`analyze-replay job for replay ${replayId} failed`, error);
		markReplayFailed(store, events, replayId, "max_attempts_exceeded");
	},
});

const app = createApp(store, { audioRoot, jobRunner, events });

const server = Bun.serve({
	port: env.PORT,
	hostname: env.HOST,
	development: process.env.NODE_ENV !== "production",
	routes: {
		"/healthz": (req) => app.fetch(req),
		"/v1/*": (req) => app.fetch(req),
		"/openapi.json": (req) => app.fetch(req),
		"/docs": (req) => app.fetch(req),
		"/*": index,
	},
});

console.info(
	`xray listening on ${server.hostname}:${server.port} (db=${env.XRAY_DATA_DIR}/xray.db, bunqueue=${bunqueuePath}, audio=${audioRoot})`,
);
