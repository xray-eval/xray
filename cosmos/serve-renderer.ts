import config from "../cosmos.config.json";
import { RendererUrlError } from "./dev.errors.ts";
import renderer from "./index.html";

/**
 * Derived from the `rendererUrl` Cosmos loads this server from, so the two
 * can't drift into a workbench whose iframe points at nothing.
 */
export const RENDERER_PORT = rendererPort(config.rendererUrl);

function rendererPort(url: string): number {
	const parsed = URL.parse(url);
	if (parsed === null || parsed.port === "") throw new RendererUrlError(url);
	return Number(parsed.port);
}

export function serveRenderer(): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: RENDERER_PORT,
		development: true,
		routes: { "/*": renderer },
	});
}
