import { mkdirSync } from "node:fs";
import { join } from "node:path";

// `import index from "*.html"` triggers Bun's HTML bundler: Bun walks the
// shell's `<script type="module">` tags and bundles the React entry on boot.
// With `bun --hot` the bundle is rebuilt + HMR'd on file change.
import index from "../../index.html";
import { loadEnv } from "./env/env.ts";
import { makeAnalyzeProcessor } from "./jobs/analyze-replay/analyze-replay.processor.ts";
import { makeCalculateMetricsProcessor } from "./jobs/calculate-metrics/calculate-metrics.processor.ts";
import { makeEvaluateReplayProcessor } from "./jobs/evaluate-replay/evaluate-replay.processor.ts";
import type { JobRunner } from "./jobs/jobs.bunqueue.ts";
import { createJobRunner } from "./jobs/jobs.bunqueue.ts";
import { JobRunnerNotInitializedError } from "./jobs/jobs.errors.ts";
import { buildJudgeProvider, buildTranscriptionProvider } from "./providers/providers.ts";
import { makeReplayEvents } from "./replays/replays.events.ts";
import { markReplayFailed } from "./replays/replays.service.ts";
import { createApp } from "./server.ts";
import { openStoreFromEnv } from "./store/store.ts";

const env = loadEnv();
const store = openStoreFromEnv(env);

const audioRoot = env.XRAY_AUDIO_ROOT ?? join(env.XRAY_DATA_DIR, "audio");
mkdirSync(audioRoot, { recursive: true });

const events = makeReplayEvents();

// Provider credentials are wrapped in factory closures so the call site
// only fails when a stage actually needs them — boot stays cheap, and
// the failure surfaces as `MissingProviderCredentialError` with the env
// var name, not as a generic 500. Tests substitute fake providers with
// their own apiKey closures and don't go through `loadEnv()`. The
// selection logic + its branch tests live in `providers/providers.ts`.
const transcriptionProvider = buildTranscriptionProvider(env);
const judgeProvider = buildJudgeProvider(env);

// bunqueue opens its own SQLite file alongside `xray.db` (see
// `.claude/rules/single-image-distribution.md`'s "one volume, two files"
// acknowledgement). Path is configurable via BUNQUEUE_DATA_PATH so an
// operator can move it; default lives in the same data volume.
const bunqueuePath = env.BUNQUEUE_DATA_PATH ?? join(env.XRAY_DATA_DIR, "bunqueue.db");

// Late-bind `jobRunner` so each processor's closure can call
// `jobRunner.enqueue(...)` to chain the next stage. The runner itself
// needs the processors at construction; the chained processors need the
// runner. Solve the cycle with a lazy ref the processors capture.
let runnerRef: JobRunner | null = null;
const lazyRunner: JobRunner = {
	async enqueue(name, payload) {
		if (runnerRef === null) throw new JobRunnerNotInitializedError();
		return runnerRef.enqueue(name, payload);
	},
	async close() {
		if (runnerRef === null) return;
		return runnerRef.close();
	},
};

runnerRef = createJobRunner({
	dataPath: bunqueuePath,
	processors: {
		"analyze-replay": makeAnalyzeProcessor(
			store,
			audioRoot,
			events,
			lazyRunner,
			transcriptionProvider,
		),
		"calculate-metrics": makeCalculateMetricsProcessor(store, events, lazyRunner),
		"evaluate-replay": makeEvaluateReplayProcessor(store, events, judgeProvider),
	},
	onFailed: (jobName, replayId, error) => {
		// bunqueue only fires `failed` once retries are exhausted. Each
		// processor catches its own failure path and stamps the
		// stage-specific failure_reason inside its transaction — by the
		// time we land here, the row is already in `failed`. This is the
		// safety net for processor crashes that escaped the inner try.
		console.error(`job ${jobName} for replay ${replayId} failed`, error);
		markReplayFailed(store, events, replayId, "max_attempts_exceeded");
	},
});
const jobRunner: JobRunner = lazyRunner;

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
