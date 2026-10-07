import config from "../cosmos.config.json";
import renderer from "./index.html";
import { rendererPort } from "./renderer-port.ts";

/**
 * Derived from the `rendererUrl` Cosmos loads this server from, so the two
 * can't drift into a workbench whose iframe points at nothing.
 */
export const RENDERER_PORT = rendererPort(config.rendererUrl);

export function serveRenderer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: RENDERER_PORT,
		// HMR off for the same Bun + @tanstack/router-core cycle crash as the
		// app's dev server — see `development` in src/server/main.ts.
		development: { hmr: false },
		routes: { "/*": renderer },
	});
}
