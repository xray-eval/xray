import { CosmosImportsTimeoutError } from "./dev.errors.ts";

const IMPORTS_FILE = new URL("./cosmos.imports.ts", import.meta.url).pathname;
const IMPORTS_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

/**
 * One command for the component workbench: the Cosmos server (playground UI +
 * fixture watcher) plus the Bun-bundled renderer it loads in an iframe.
 *
 * The renderer is a separate process concern from Cosmos itself — this is
 * Cosmos's "custom bundler" mode, which is what keeps the workbench on Bun's
 * bundler instead of pulling in Vite or webpack.
 */
// No `--expose-imports` flag: passed bare it parses as a boolean, which wins
// over the path in cosmos.config.json and drops the generated file at the repo
// root instead of in here.
const cosmos = Bun.spawn(["pnpm", "exec", "cosmos"], {
	stdout: "inherit",
	stderr: "inherit",
});

function shutdown(): void {
	cosmos.kill();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// The renderer module imports the generated cosmos.imports.ts statically, so
// it cannot even be loaded until Cosmos has written that file. Waiting here
// rather than assuming Bun defers the HTML bundle keeps first-run (where the
// file has never existed) working the same as every later run.
const deadline = Date.now() + IMPORTS_TIMEOUT_MS;
while (!(await Bun.file(IMPORTS_FILE).exists())) {
	if (Date.now() > deadline) {
		cosmos.kill();
		throw new CosmosImportsTimeoutError(IMPORTS_FILE, IMPORTS_TIMEOUT_MS);
	}
	await Bun.sleep(POLL_INTERVAL_MS);
}

const { serveRenderer } = await import("./serve-renderer.ts");
const server = serveRenderer();

console.info(
	`[cosmos] renderer on http://localhost:${server.port} — playground on http://localhost:5050`,
);

await cosmos.exited;
server.stop();
