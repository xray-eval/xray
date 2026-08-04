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
		development: true,
		routes: { "/*": renderer },
	});
}
